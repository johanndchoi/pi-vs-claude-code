-- Fix payout_timeline function: better interval calculation, filter outliers
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
