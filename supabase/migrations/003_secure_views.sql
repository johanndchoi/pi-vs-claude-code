-- Fix: Views are security definer by default, making them publicly accessible
-- Change to security_invoker so they respect the caller's RLS policies
-- (Postgres 15+, supported by Supabase)

ALTER VIEW order_profitability SET (security_invoker = on);
ALTER VIEW low_stock_alerts SET (security_invoker = on);
ALTER VIEW shipping_cost_by_platform SET (security_invoker = on);
ALTER VIEW daily_sales_summary SET (security_invoker = on);

-- Also revoke direct access from anon and authenticated roles on all views
REVOKE ALL ON order_profitability FROM anon, authenticated;
REVOKE ALL ON low_stock_alerts FROM anon, authenticated;
REVOKE ALL ON shipping_cost_by_platform FROM anon, authenticated;
REVOKE ALL ON daily_sales_summary FROM anon, authenticated;

-- Grant access only to service_role
GRANT SELECT ON order_profitability TO service_role;
GRANT SELECT ON low_stock_alerts TO service_role;
GRANT SELECT ON shipping_cost_by_platform TO service_role;
GRANT SELECT ON daily_sales_summary TO service_role;

-- Also secure the check_rls_status function (remove public access)
REVOKE ALL ON FUNCTION check_rls_status() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION check_rls_status() TO service_role;
