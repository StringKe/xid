// Astro integration middleware entrypoint.
// The integration provides this server-only configuration through a Vite virtual module.

import options from 'virtual:@xid-kit/astro:config'

import { createXidMiddleware } from './middleware'

export const onRequest = createXidMiddleware(options)
