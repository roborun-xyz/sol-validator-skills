/** A provider or network failure that a bounded read-only retry may outlast. */
export class TransportError extends Error {}

/** Every HTTP request uses the same timeout and refuses redirects. */
export async function fetchResponse(url: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> {
 try { return await fetch(url, {...init, redirect:'error', signal:AbortSignal.timeout(20000)}); }
 catch { throw new TransportError('HTTP transport failed; URL omitted.'); }
}

/** Read-only JSON fetches: bounded retries, no provider bodies/credentials in errors. */
export async function fetchJson<T>(url:string, init?:RequestInit, retries=4, optional404=false):Promise<T> {
 for(let attempt=0;;attempt++) {
  try {
   const response=await fetchResponse(url,init);
   if(optional404 && response.status===404) return null as T;
   if(!response.ok) throw new Error(`HTTP ${response.status}`);
   return await response.json() as T;
  } catch {
   if(attempt>=retries) throw new TransportError('JSON request failed after bounded retries; check provider availability and credentials (URL and response body omitted).');
   await new Promise(resolve=>setTimeout(resolve,500*2**attempt));
  }
 }
}
export const fetchOptionalJson=<T>(url:string,init?:RequestInit,retries=4)=>fetchJson<T|null>(url,init,retries,true);
