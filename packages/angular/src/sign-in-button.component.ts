// 跳转到 Hosted UI 登录页（Authorization Code + PKCE S256，由服务端完成）。

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
  @Input() signInUrl = '/sign-in'
  @Input() redirectUrl?: string
  @Input() ariaLabel?: string

  handleClick(): void {
    const target = this.redirectUrl
      ? `${this.signInUrl}?redirect_url=${encodeURIComponent(this.redirectUrl)}`
      : this.signInUrl
    window.location.assign(target)
  }
}
