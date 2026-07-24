// Protect:权限门控容器(对标 @clerk/vue Protect 的 Vue 版)。
// 检查 isSignedIn + 可选 permission/role;不满足时渲染 fallback slot 或 null。

import { computed, defineComponent, h } from 'vue'

import { useXidState } from '../composables/use-xid-state'

export type ProtectProps = {
  // 要求拥有该 permission(org 权限字符串,如 "org:member:read")
  permission?: string
  // 要求拥有该 role(如 "org:admin")
  role?: string
}

export const Protect = defineComponent({
  name: 'Protect',

  props: {
    permission: {
      type: String,
      default: undefined,
    },
    role: {
      type: String,
      default: undefined,
    },
  },

  setup(props, { slots }) {
    const state = useXidState()

    const canRender = computed((): boolean => {
      if (!state.value.isLoaded || !state.value.isSignedIn) return false

      const hasCheck = props.permission !== undefined || props.role !== undefined
      if (!hasCheck) return true

      const memberships = state.value.user?.organizationMemberships ?? []
      const activeMembership = memberships.find(
        (m) => m.organization.id === state.value.organization?.id,
      )

      if (props.role !== undefined && activeMembership?.role !== props.role) return false
      if (
        props.permission !== undefined &&
        !activeMembership?.permissions.includes(props.permission)
      )
        return false

      return true
    })

    return () => {
      if (canRender.value) {
        return slots.default ? h('span', slots.default()) : null
      }
      return slots.fallback ? h('span', slots.fallback()) : null
    }
  },
})
