// Separate from authenticated online requests: never accepts or adds auth headers.
export function createAnonymousContributionRequest(api) {
  return ({ url, data, method = 'POST' }) => {
    let task, settled = false, rejectRequest, timer;
    const finish = (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (error) rejectRequest(error); else resolveRequest(value);
    };
    let resolveRequest;
    const promise = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
    const abort = () => {
      finish(new Error('CANCELLED'));
      try { task?.abort?.(); } catch (_) { /* Request is already locally cancelled. */ }
    };
    timer = setTimeout(abort, 15000);
    try {
      task = api.request({ url, method: method === 'GET' ? 'GET' : 'POST', ...(method === 'GET' ? {} : { data }), timeout: 15000,
        header: { 'Content-Type': 'application/json' }, enableCookie: false,
        success: response => finish(null, { status: response.statusCode, data: response.data }),
        fail: () => finish(new Error('NETWORK_ERROR')) });
    } catch (_) { finish(new Error('NETWORK_ERROR')); }
    return { promise, abort };
  };
}
