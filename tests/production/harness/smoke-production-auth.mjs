#!/usr/bin/env node

import { signInWithEmailOtp } from './production-auth.mjs'

export async function runProductionAuthSmoke() {
  await signInWithEmailOtp()
}
