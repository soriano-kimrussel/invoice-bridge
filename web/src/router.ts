import { useEffect, useState } from 'react';

/** Two routes are all this app needs: `/` (queue) and `/invoices/:id` (review). */
export type Route = { name: 'queue'; tab: string | null } | { name: 'invoice'; id: string };

function parse(): Route {
  const m = window.location.pathname.match(/^\/invoices\/([0-9a-f-]{36})\/?$/i);
  if (m) return { name: 'invoice', id: m[1]! };
  return { name: 'queue', tab: new URLSearchParams(window.location.search).get('tab') };
}

export function navigate(to: string) {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return route;
}
