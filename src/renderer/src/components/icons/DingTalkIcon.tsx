import type { SVGProps } from 'react'
import { DINGTALK_ICON_PATH, DINGTALK_ICON_VIEW_BOX } from '../../../../shared/bots/dingtalk-icon'

export function DingTalkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="currentColor"
      viewBox={`0 0 ${DINGTALK_ICON_VIEW_BOX} ${DINGTALK_ICON_VIEW_BOX}`}
      aria-hidden
      {...props}
    >
      <path d={DINGTALK_ICON_PATH} />
    </svg>
  )
}
