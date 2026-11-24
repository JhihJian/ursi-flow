'use client'

import * as React from 'react'
import * as SwitchPrimitive from '@radix-ui/react-switch'

import { cn } from '../lib/utils'

/**
 * 共享开关：Radix Switch 提供 role=switch 与键盘行为，外观保持旧 AppSwitch
 * （accent 轨道 + 白色滑块，关态描边 + 灰色滑块）。
 */
const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        'app-switch relative h-[22px] w-10 shrink-0 border border-line-strong bg-base disabled:cursor-not-allowed disabled:opacity-45 data-[state=checked]:border-accent data-[state=checked]:bg-accent',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="app-switch-thumb pointer-events-none block h-4 w-4 bg-txt2 data-[state=checked]:bg-primary-foreground" />
    </SwitchPrimitive.Root>
  )
})

export { Switch }
