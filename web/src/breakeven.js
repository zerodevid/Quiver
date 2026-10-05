// The implementation lives in src/ so the server (Telegram chart card) and the dashboard
// use exactly the same BEP formula — src/ is shipped to the VPS, web/src is not.
export { breakEven } from '../../src/breakeven.mjs';
