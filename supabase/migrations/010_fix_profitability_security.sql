-- Fix: order_profitability view was missing security_invoker
-- Without this, the view bypasses RLS and is publicly accessible via anon key
ALTER VIEW order_profitability SET (security_invoker = on);
