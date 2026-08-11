import { computed, defineComponent, h, type PropType } from 'vue'
import type { OrganizationMembershipRole } from '@xid-kit/types'

import { useXidState } from '../composables/use-xid-state'

export type ProtectProps = {
  permission?: string
  role?: OrganizationMembershipRole
}

export const Protect = defineComponent({
  name: 'Protect',

  props: {
    permission: {
      type: String,
      default: undefined,
    },
    role: {
      type: String as PropType<OrganizationMembershipRole>,
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
