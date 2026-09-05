"""Nightly reporting job."""

import subprocess
import sys


def export_report(customer: str) -> str:
    """Export one customer's rows.

    Planted defect: the customer name reaches a shell command unquoted.
    """
    sql = f"SELECT * FROM orders WHERE customer = '{customer}'"
    result = subprocess.run(
        f"psql -tAc \"{sql}\" > /tmp/report.csv", shell=True, capture_output=True, text=True
    )
    return result.stdout


if __name__ == "__main__":
    print(export_report(sys.argv[1]))
