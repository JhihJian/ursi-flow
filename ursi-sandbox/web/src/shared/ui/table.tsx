import type { ComponentProps } from 'react'
import { cn } from '../lib/utils'

export function Table({ className, ...props }: ComponentProps<'table'>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table
        className={cn(
          'w-full caption-bottom border-collapse text-left text-sm',
          className,
        )}
        {...props}
      />
    </div>
  )
}
export function TableHeader(props: ComponentProps<'thead'>) {
  return <thead {...props} />
}
export function TableBody(props: ComponentProps<'tbody'>) {
  return <tbody {...props} />
}
export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return (
    <tr
      className={cn(
        'border-b border-line transition-colors hover:bg-elevated/50',
        className,
      )}
      {...props}
    />
  )
}
export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return (
    <th
      scope="col"
      className={cn(
        'h-10 px-4 text-left font-serif text-[11px] font-semibold uppercase tracking-[0.5px] text-txt3',
        className,
      )}
      {...props}
    />
  )
}
export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return (
    <td
      className={cn('px-4 py-3 align-top text-txt', className)}
      {...props}
    />
  )
}
