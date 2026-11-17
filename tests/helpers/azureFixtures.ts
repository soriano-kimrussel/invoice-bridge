import type { AnalyzeResultOutput } from '@azure-rest/ai-document-intelligence';

/** Shaped like a real prebuilt-invoice result (trimmed: no pages/spans/bounding regions). */
export function azureInvoiceResult(overrides: Record<string, unknown> = {}): AnalyzeResultOutput {
  const money = (amount: number, confidence: number, currencyCode = 'AUD') => ({
    type: 'currency',
    valueCurrency: { amount, currencySymbol: '$', currencyCode },
    content: `$${amount.toFixed(2)}`,
    confidence,
  });
  return {
    apiVersion: '2024-11-30',
    modelId: 'prebuilt-invoice',
    stringIndexType: 'textElements',
    content: '…',
    pages: [],
    documents: [
      {
        docType: 'invoice',
        confidence: 1,
        fields: {
          VendorName: { type: 'string', valueString: 'Acme Supplies Pty Ltd', content: 'Acme Supplies Pty Ltd', confidence: 0.981 },
          InvoiceId: { type: 'string', valueString: 'INV-1001', content: 'INV-1001', confidence: 0.973 },
          InvoiceDate: { type: 'date', valueDate: '2026-11-01', content: '1 Nov 2026', confidence: 0.962 },
          DueDate: { type: 'date', valueDate: '2026-11-30', content: '30 Nov 2026', confidence: 0.612 },
          SubTotal: money(100, 0.95),
          TotalTax: money(10, 0.948),
          InvoiceTotal: money(110, 0.99),
          Items: {
            type: 'array',
            valueArray: [
              {
                type: 'object',
                confidence: 0.9,
                valueObject: {
                  Description: { type: 'string', valueString: 'Widgets', content: 'Widgets', confidence: 0.93 },
                  Quantity: { type: 'number', valueNumber: 10, content: '10', confidence: 0.92 },
                  UnitPrice: money(10, 0.5),
                  Amount: money(100, 0.94),
                },
              },
            ],
          },
          ...overrides,
        },
      },
    ],
  } as unknown as AnalyzeResultOutput;
}
