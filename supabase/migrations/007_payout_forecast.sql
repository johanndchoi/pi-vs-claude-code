-- Payout forecast: expected upcoming deposits based on historical cadence
-- Amazon pays every ~3 days (biweekly cycle, typically 2-7 day windows)
-- Walmart pays biweekly (every ~14 days via Payoneer)

-- View: unsettled orders (revenue earned but not yet in a settlement/payout)
CREATE OR REPLACE VIEW unsettled_orders WITH (security_invoker = on) AS
WITH last_settlement AS (
    SELECT
        channel_id,
        MAX(period_end) AS last_period_end,
        MAX(payout_date) AS last_payout_date
    FROM payouts
    GROUP BY channel_id
),
-- For Walmart, use the latest recon report date as proxy
walmart_last AS (
    SELECT
        '2da7e1e0-579e-4968-bdef-fa18492a6a86'::uuid AS channel_id,
        COALESCE(
            (SELECT MAX((metadata->>'report_date')::text) FROM channel_fees WHERE channel_id = '2da7e1e0-579e-4968-bdef-fa18492a6a86'),
            '2024-01-01'
        ) AS last_report_date
)
SELECT
    o.id AS order_id,
    o.order_number,
    o.channel_id,
    c.name AS channel_name,
    o.ordered_at,
    o.subtotal,
    o.total,
    o.status,
    CASE
        WHEN ls.last_period_end IS NOT NULL
        THEN o.ordered_at > ls.last_period_end
        ELSE true
    END AS is_unsettled
FROM orders o
JOIN channels c ON c.id = o.channel_id
LEFT JOIN last_settlement ls ON ls.channel_id = o.channel_id
WHERE o.status NOT IN ('cancelled', 'refunded')
  AND (
    -- Amazon: after last settlement period end
    (o.channel_id = '7f84462f-86c8-4e09-abb6-285631db0d83'
     AND o.ordered_at > COALESCE(ls.last_period_end, '2024-01-01'))
    OR
    -- Walmart: after last recon report period
    (o.channel_id = '2da7e1e0-579e-4968-bdef-fa18492a6a86'
     AND o.ordered_at > (
       SELECT COALESCE(MAX(period_end), '2024-01-01') FROM payouts WHERE channel_id = o.channel_id
     ))
    OR
    -- Other channels: no settlement tracking, show last 14 days
    (o.channel_id NOT IN (
      '7f84462f-86c8-4e09-abb6-285631db0d83',
      '2da7e1e0-579e-4968-bdef-fa18492a6a86'
     ) AND o.ordered_at > NOW() - INTERVAL '14 days')
  );

-- Function: payout forecast summary
CREATE OR REPLACE FUNCTION payout_forecast()
RETURNS TABLE (
    channel_name TEXT,
    unsettled_orders BIGINT,
    unsettled_revenue NUMERIC,
    estimated_fees NUMERIC,
    estimated_net NUMERIC,
    last_payout_date DATE,
    last_payout_amount NUMERIC,
    avg_payout_interval_days NUMERIC,
    avg_payout_amount NUMERIC,
    next_expected_payout DATE,
    next_expected_amount NUMERIC
)
LANGUAGE sql SECURITY INVOKER STABLE
AS $$
    WITH channel_stats AS (
        SELECT
            p.channel_id,
            c.name AS channel_name,
            MAX(p.payout_date) AS last_payout_date,
            (SELECT net_amount FROM payouts p2 WHERE p2.channel_id = p.channel_id ORDER BY p2.payout_date DESC LIMIT 1) AS last_payout_amount,
            AVG(p.net_amount) AS avg_payout_amount,
            -- Average days between payouts (last 10)
            (SELECT AVG(interval_days) FROM (
                SELECT payout_date - LAG(payout_date) OVER (ORDER BY payout_date) AS interval_days
                FROM payouts p3
                WHERE p3.channel_id = p.channel_id
                ORDER BY p3.payout_date DESC
                LIMIT 10
            ) sub WHERE interval_days IS NOT NULL) AS avg_interval
        FROM payouts p
        JOIN channels c ON c.id = p.channel_id
        GROUP BY p.channel_id, c.name
    ),
    unsettled AS (
        SELECT
            channel_id,
            COUNT(*) AS order_count,
            SUM(total) AS revenue
        FROM unsettled_orders
        GROUP BY channel_id
    ),
    -- Estimate fees based on historical fee rate
    fee_rates AS (
        SELECT
            cf.channel_id,
            SUM(cf.amount) / NULLIF(SUM(o.total), 0) AS fee_rate
        FROM channel_fees cf
        JOIN orders o ON o.id = cf.order_id
        WHERE o.ordered_at > NOW() - INTERVAL '90 days'
        GROUP BY cf.channel_id
    )
    SELECT
        cs.channel_name,
        COALESCE(u.order_count, 0),
        COALESCE(u.revenue, 0),
        ROUND(COALESCE(u.revenue * COALESCE(fr.fee_rate, 0.15), 0), 2) AS estimated_fees,
        ROUND(COALESCE(u.revenue - u.revenue * COALESCE(fr.fee_rate, 0.15), 0), 2) AS estimated_net,
        cs.last_payout_date,
        ROUND(cs.last_payout_amount, 2),
        ROUND(cs.avg_interval, 1),
        ROUND(cs.avg_payout_amount, 2),
        (cs.last_payout_date + COALESCE(cs.avg_interval, 14)::int) AS next_expected_payout,
        ROUND(cs.avg_payout_amount, 2) AS next_expected_amount
    FROM channel_stats cs
    LEFT JOIN unsettled u ON u.channel_id = cs.channel_id
    LEFT JOIN fee_rates fr ON fr.channel_id = cs.channel_id
    ORDER BY cs.channel_name;
$$;

-- Function: upcoming payout timeline (day-by-day forecast)
CREATE OR REPLACE FUNCTION payout_timeline(days_ahead INT DEFAULT 30)
RETURNS TABLE (
    expected_date DATE,
    channel_name TEXT,
    estimated_amount NUMERIC,
    confidence TEXT
)
LANGUAGE sql SECURITY INVOKER STABLE
AS $$
    WITH recent_payouts AS (
        -- Get last 20 payouts per channel for cadence calculation
        SELECT * FROM (
            SELECT
                p.channel_id,
                c.name AS channel_name,
                p.payout_date,
                p.net_amount,
                ROW_NUMBER() OVER (PARTITION BY p.channel_id ORDER BY p.payout_date DESC) AS rn
            FROM payouts p
            JOIN channels c ON c.id = p.channel_id
        ) sub WHERE rn <= 20
    ),
    payout_intervals AS (
        SELECT
            channel_id,
            channel_name,
            payout_date,
            net_amount,
            payout_date - LAG(payout_date) OVER (PARTITION BY channel_id ORDER BY payout_date) AS days_since_last
        FROM recent_payouts
    ),
    channel_cadence AS (
        SELECT
            channel_id,
            channel_name,
            MAX(payout_date) AS last_payout,
            -- Use median-like approach: filter out outliers (>21 days = probably reserve holds)
            GREATEST(ROUND(AVG(days_since_last) FILTER (WHERE days_since_last IS NOT NULL AND days_since_last BETWEEN 1 AND 21), 0), 1) AS avg_interval,
            ROUND(AVG(net_amount), 2) AS avg_amount
        FROM payout_intervals
        GROUP BY channel_id, channel_name
    ),
    projected AS (
        SELECT
            cc.channel_name,
            (cc.last_payout + (n * cc.avg_interval::int))::date AS expected_date,
            cc.avg_amount AS estimated_amount,
            CASE
                WHEN n = 1 THEN 'high'
                WHEN n = 2 THEN 'medium'
                ELSE 'low'
            END AS confidence
        FROM channel_cadence cc
        CROSS JOIN generate_series(1, 15) AS n
        WHERE (cc.last_payout + (n * cc.avg_interval::int))::date <= CURRENT_DATE + days_ahead
          AND (cc.last_payout + (n * cc.avg_interval::int))::date >= CURRENT_DATE
    )
    SELECT
        p.expected_date,
        p.channel_name,
        p.estimated_amount,
        p.confidence
    FROM projected p
    ORDER BY p.expected_date, p.channel_name;
$$;
