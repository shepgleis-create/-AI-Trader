export function logTraderEvent(type, payload = {}) {
  try {
    console.log('AI_TRADER_EVENT ' + JSON.stringify({
      ts: new Date().toISOString(),
      type,
      ...payload
    }));
  } catch {
    console.log('AI_TRADER_EVENT ' + type);
  }
}
