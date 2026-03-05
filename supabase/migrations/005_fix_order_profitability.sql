-- Fix order_profitability view
-- Problems with original:
-- 1. Cartesian product from multiple JOINs (order_items × channel_fees × shipments)
-- 2. Uses s.total_cost which is often null; should fallback to label_cost
-- 3. SUM(DISTINCT) hack doesn't reliably fix the cartesian product

DROP VIEW IF EXISTS order_profitability;

CREATE VIEW order_profitability AS
SELECT
    o.id AS order_id,
    o.order_number,
    o.ordered_at,
    c.name AS channel_name,
    o.total AS revenue,
    o.subtotal,
    o.tax_amount,
    o.shipping_cost AS customer_shipping,
    o.discount_amount,
    COALESCE(item_costs.cogs, 0) AS cogs,
    COALESCE(fee_totals.total_fees, 0) AS total_fees,
    COALESCE(ship_costs.shipping_cost, 0) AS shipping_cost,
    o.total
        - COALESCE(item_costs.cogs, 0)
        - COALESCE(fee_totals.total_fees, 0)
        - COALESCE(ship_costs.shipping_cost, 0)
        AS gross_profit,
    CASE WHEN o.total > 0 THEN
        ROUND((o.total
            - COALESCE(item_costs.cogs, 0)
            - COALESCE(fee_totals.total_fees, 0)
            - COALESCE(ship_costs.shipping_cost, 0)
        ) / o.total * 100, 1)
    END AS margin_pct
FROM orders o
LEFT JOIN channels c ON o.channel_id = c.id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(oi.cost_price * oi.quantity), 0) AS cogs
    FROM order_items oi WHERE oi.order_id = o.id
) item_costs ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(cf.amount), 0) AS total_fees
    FROM channel_fees cf WHERE cf.order_id = o.id
) fee_totals ON true
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(COALESCE(s.total_cost, s.label_cost, 0)), 0) AS shipping_cost
    FROM shipments s WHERE s.order_id = o.id AND s.is_voided = false
) ship_costs ON true;

-- Re-apply security settings
ALTER VIEW order_profitability SET (security_invoker = on);
REVOKE ALL ON order_profitability FROM anon, authenticated;
GRANT SELECT ON order_profitability TO service_role;
