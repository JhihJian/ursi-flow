import type { ComponentProps } from 'react'
import { cn } from '../lib/utils'

// shadcn/ui Table primitives, themed with Workbench tokens.
export function Table({ className, ...props }: ComponentProps<'table'>) {
  return <div data-slot="table-container" className="relative w-full overflow-x-auto"><table data-slot="table" className={cn('w-full caption-bottom text-sm', className)} {...props} /></div>
}
export function TableHeader(props: ComponentProps<'thead'>) { return <thead data-slot="table-header" {...props} /> }
export function TableBody(props: ComponentProps<'tbody'>) { return <tbody data-slot="table-body" {...props} /> }
export function TableRow({ className, ...props }: ComponentProps<'tr'>) { return <tr data-slot="table-row" className={cn('border-b border-line hover:bg-elevated data-[state=selected]:bg-accent-dim', className)} {...props} /> }
export function TableHead(props: ComponentProps<'th'>) { return <th scope="col" data-slot="table-head" className="px-3 py-2 text-left text-xs font-medium text-txt3" {...props} /> }
export function TableCell(props: ComponentProps<'td'>) { return <td data-slot="table-cell" className="break-words px-3 py-2 align-middle" {...props} /> }
