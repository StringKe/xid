// SignInButton: minimal standalone Angular component that navigates to the
// Hosted UI sign-in page (Authorization Code + PKCE S256 flow via server).
// No NgModule required (Angular 17+ standalone).
//
// Usage:
//   <xid-sign-in-button />
//   <xid-sign-in-button signInUrl="/auth/sign-in" redirectUrl="/dashboard">
//     Log in
//   </xid-sign-in-button>

import { Component, Input } from '@angular/core'

@Component({
  selector: 'xid-sign-in-button',
  standalone: true,
  template: `
    <button type="button" [attr.aria-label]="ariaLabel || null" (click)="handleClick()">
      <ng-content>Sign in</ng-content>
    </button>
  `,
})
export class SignInButton {
  // Route to the Hosted UI sign-in page. Defaults to '/sign-in'.
  @Input() signInUrl = '/sign-in'
  // After successful sign-in the server will redirect here.
  @Input() redirectUrl?: string
  // Accessible label for assistive technology; optional.
  @Input() ariaLabel?: string

  handleClick(): void {
    const target = this.redirectUrl
      ? `${this.signInUrl}?redirect_url=${encodeURIComponent(this.redirectUrl)}`
      : this.signInUrl
    window.location.assign(target)
  }
}
