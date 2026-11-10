const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const transient = error => [500, 502, 503, 504].includes(error.status)
  || (!error.status && (error.message === 'fetch failed' || ['TimeoutError', 'AbortError'].includes(error.name)));

// Retry the whole publication, which re-reads branch, file SHAs and the comment
// marker before writing. Never blindly repeat a POST whose response was lost.
async function retryPublication(action, onRetry = () => {}, wait = sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt >= 2 || !transient(error)) throw error;
      const delay = 1000 * 2 ** attempt;
      onRetry(attempt + 1, delay);
      await wait(delay);
    }
  }
}
module.exports = { retryPublication };
