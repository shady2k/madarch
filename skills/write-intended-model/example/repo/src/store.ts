// The archive: every imported receipt, kept by id for the life of the process.
export interface Receipt {
  id: string;
  vendor: string;
  date: string;
  total: number;
}

const receipts = new Map<string, Receipt>();

export function storeReceipt(receipt: Receipt): void {
  receipts.set(receipt.id, receipt);
}

export function findReceipt(id: string): Receipt | undefined {
  return receipts.get(id);
}
