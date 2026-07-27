import { config } from 'virtual:nimbus/config'

export const prerender = true

export function GET() {
  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /sign-in',
    'Disallow: /sign-up',
    'Disallow: /account',
    'Disallow: /console',
    'Disallow: /auth',
    'Disallow: /v1',
    '',
    `Sitemap: ${new URL('/sitemap.xml', config.site).href}`,
    '',
  ].join('\n')

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}
