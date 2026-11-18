"""门店日结：python3 close.py orders.csv report.csv

一份流水只含一个营业日（YYYY-MM-DD），流水号全表唯一。payment 是收款，
refund 是退款，两者的 amount_cents 均为正整数分。报表按店名升序，使用 UTF-8、LF。
"""

import argparse
import csv
import os
import re
from datetime import date
from pathlib import Path
from tempfile import NamedTemporaryFile


ORDER_HEADER = ["transaction_id", "date", "store", "type", "amount_cents"]
REPORT_HEADER = ["store", "payment_cents", "refund_cents", "net_cents"]


def summarize(path):
    totals = {}
    seen = set()
    business_day = None
    with path.open(encoding="utf-8", newline="") as source:
        rows = csv.reader(source, strict=True)
        if next(rows, None) != ORDER_HEADER:
            raise ValueError("流水表头应为 " + ",".join(ORDER_HEADER))
        for row in rows:
            line = f"第 {rows.line_num} 行："
            if len(row) != len(ORDER_HEADER):
                raise ValueError(line + "流水列数不正确")
            transaction, day, store, kind, amount = row
            if not transaction.strip() or not store.strip():
                raise ValueError(line + "流水号和店名不能为空")
            if transaction in seen:
                raise ValueError(line + f"重复流水号 {transaction}")
            if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}", day):
                raise ValueError(line + "日期格式应为 YYYY-MM-DD")
            day = date.fromisoformat(day)
            if business_day is not None and business_day != day:
                raise ValueError(line + "流水含多个营业日")
            if kind not in ("payment", "refund"):
                raise ValueError(line + "流水类型应为 payment 或 refund")
            if not re.fullmatch(r"[0-9]+", amount) or int(amount) == 0:
                raise ValueError(line + "金额必须为正整数分")
            seen.add(transaction)
            business_day = day
            store_totals = totals.setdefault(store, {"payment": 0, "refund": 0})
            store_totals[kind] += int(amount)
    return totals


def write_report(path, totals):
    # 在目标目录写完并关闭临时文件后再替换，写入失败时旧报表仍完整。
    temp_path = None
    try:
        with NamedTemporaryFile(mode="w", encoding="utf-8", newline="", dir=path.parent,
                                delete=False) as output:
            temp_path = Path(output.name)
            writer = csv.writer(output, lineterminator="\n")
            writer.writerow(REPORT_HEADER)
            for store, amounts in sorted(totals.items()):
                paid, refunded = amounts["payment"], amounts["refund"]
                writer.writerow([store, paid, refunded, paid - refunded])
        os.replace(temp_path, path)
    finally:
        if temp_path is not None and temp_path.exists():
            temp_path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("orders", type=Path)
    parser.add_argument("report", type=Path)
    args = parser.parse_args()
    try:
        write_report(args.report, summarize(args.orders))
    except (ValueError, csv.Error, OSError) as error:
        parser.exit(1, f"日结失败：{error}\n")


if __name__ == "__main__":
    main()
