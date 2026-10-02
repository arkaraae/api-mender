// The site's own API handlers, for a host that does not let a site call itself over HTTP.
// Leave the list empty and Mender reaches the API over HTTP instead (the default).
//
// Each entry takes a standard Request and returns a Response, for example:
//
//   import { POST as createQuote } from '../app/api/managed/quotes/route';
//   import { GET as contract } from '../app/api/managed/openapi.json/route';
//
//   export const routes = {
//     '/api/managed/quotes': createQuote,
//     '/api/managed/openapi.json': contract,
//   };
export const routes = {};
