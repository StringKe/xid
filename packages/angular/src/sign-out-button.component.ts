// SignOutButton: minimal standalone Angular component that calls XidAuthService.signOut().
// No NgModule required (Angular 17+ standalone).
//
// Usage:
//   <xid-sign-out-button />
//   <xid-sign-out-button [sessionId]="session.id" redirectUrl="/home">
//     Log out of this session
//   </xid-sign-out-button>

import { Component, inject, Input } from '@angular/core'

import { XidAuthService } from './xid-auth.service'

@Component({
  selector: 'xid-sign-out-button',
  standalone: true,
  template: `
    <button
      type="button"
      [attr.aria-label]="ariaLabel || null"
      [attr.aria-busy]="pending"
      [disabled]="pending"
      (click)="onClickEvent()"
    >
      <ng-content>Sign out</ng-content>
    </button>
  `,
})
export class SignOutButton {
  readonly #auth = inject(XidAuthService)

  // Target session to sign out; omit to sign out all sessions.
  @Input() sessionId?: string
  // Navigate here after a successful sign-out; omit to stay on the page.
  @Input() redirectUrl?: string
  // Accessible label for assistive technology; optional.
  @Input() ariaLabel?: string

  protected pending = false

  // onClickEvent is synchronous; the async work is queued via a void-marked promise.
  onClickEvent(): void {
    void this.#doSignOut()
  }

  async #doSignOut(): Promise<void> {
    if (this.pending) return
    this.pending = true
    try {
      const result = await this.#auth.signOut(
        this.sessionId ? { sessionId: this.sessionId } : undefined,
      )
      if (result.ok && this.redirectUrl) {
        window.location.assign(this.redirectUrl)
      }
    } finally {
      this.pending = false
    }
  }
}
