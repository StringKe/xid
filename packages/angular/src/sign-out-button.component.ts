// 调用 XidAuthService.signOut() 的 standalone 登出按钮。

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

  @Input() sessionId?: string
  @Input() redirectUrl?: string
  @Input() ariaLabel?: string

  protected pending = false

  // 模板 (click) 要求同步处理器；异步登出经 void 标记的 Promise 排队。
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
