const redact = (value) => typeof value === 'string' ? value.replace(/(api[_-]?key|token|authorization)=?[^\s,]+/gi, '$1=[REDACTED]') : value;
export function logger(level = 'info') {
  const emit = (severity, event, meta = {}) => { if (['debug','info','warn','error'].indexOf(severity) >= ['debug','info','warn','error'].indexOf(level)) console.log(JSON.stringify({ time: new Date().toISOString(), severity, event, ...Object.fromEntries(Object.entries(meta).map(([k,v]) => [k, redact(v)])) })); };
  return Object.fromEntries(['debug','info','warn','error'].map((s) => [s, (event, meta) => emit(s, event, meta)]));
}
