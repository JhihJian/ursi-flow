import { useState } from 'react'
import { flexRender, getCoreRowModel, getPaginationRowModel, useReactTable, type ColumnDef } from '@tanstack/react-table'
import { Table, TableHeader, TableHead, TableRow, TableBody, TableCell } from './table'
import { Button } from './button'

export function DataTable<T>({ label, columns, data, rowId, selected }: { label: string; columns: ColumnDef<T>[]; data: T[]; rowId: (item: T) => string; selected?: string | null }) {
  const [page, setPage] = useState(0)
  const pageCount = Math.max(1, Math.ceil(data.length / 12))
  const pageIndex = Math.min(page, pageCount - 1)
  // The table instance is intentionally consumed within this render, not memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({ data, columns, getRowId: rowId, getCoreRowModel: getCoreRowModel(), getPaginationRowModel: getPaginationRowModel(), autoResetPageIndex: false, state: { pagination: { pageSize: 12, pageIndex } } })
  return <div className="min-w-0"><Table aria-label={label}>
    <TableHeader>{table.getHeaderGroups().map(group => <TableRow key={group.id}>{group.headers.map(header => <TableHead key={header.id}>{flexRender(header.column.columnDef.header, header.getContext())}</TableHead>)}</TableRow>)}</TableHeader>
    <TableBody>{table.getRowModel().rows.map(row => <TableRow key={row.id} data-state={row.id === selected ? 'selected' : undefined}>{row.getVisibleCells().map(cell => <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>)}</TableRow>)}</TableBody>
  </Table>{pageCount > 1 && <nav aria-label={`${label}分页`} className="flex items-center justify-end gap-2 p-2 text-xs"><Button size="sm" disabled={!pageIndex} onClick={() => setPage(pageIndex - 1)}>上一页</Button>{pageIndex + 1} / {pageCount}<Button size="sm" disabled={pageIndex + 1 === pageCount} onClick={() => setPage(pageIndex + 1)}>下一页</Button></nav>}</div>
}
