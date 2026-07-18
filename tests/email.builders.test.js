'use strict';

const {
  buildCase1Email,
  buildCase2AlertEmail,
  buildCase2ActionEmail,
  buildCase3Email,
  buildCase3AllClearEmail,
} = require('../src/email');

describe('buildCase1Email', () => {
  const errors = [
    {
      itemCode: '500936', itemName: 'Frango Grelhado',
      store: '6 - Cittá Delirio Restaurante',
      firstDate: '01/07/2026', lastDate: '10/07/2026', occurrences: 5,
    },
    {
      itemCode: '300086', itemName: 'Molho Especial',
      store: '7 - Delitrop Restaurante',
      firstDate: '05/07/2026', lastDate: '05/07/2026', occurrences: 1,
    },
  ];

  test('returns HTML string', () => {
    const html = buildCase1Email(errors);
    expect(typeof html).toBe('string');
    expect(html).toMatch(/<html/i);
    expect(html).toMatch(/<\/html>/i);
  });

  test('includes all item codes', () => {
    const html = buildCase1Email(errors);
    expect(html).toContain('500936');
    expect(html).toContain('300086');
  });

  test('includes item names', () => {
    const html = buildCase1Email(errors);
    expect(html).toContain('Frango Grelhado');
    expect(html).toContain('Molho Especial');
  });

  test('includes store name', () => {
    const html = buildCase1Email(errors);
    expect(html).toContain('6 - Cittá Delirio Restaurante');
  });

  test('handles empty array without crashing', () => {
    const html = buildCase1Email([]);
    expect(html).toMatch(/<html/i);
  });
});

describe('buildCase2AlertEmail', () => {
  const errors = [
    {
      itemCode: '500720', itemName: 'Azeite',
      store: '7 - Delitrop', errorDates: ['10/07/2026'],
      bomRows: [{ level: 'L1', bomParent: 'VENDA-RISOTO', via: null, contribution: 0.0049 }],
    },
    {
      itemCode: '300010', itemName: 'Sal Grosso',
      store: '14 - Niteroi', errorDates: ['11/07/2026'],
      bomRows: [{ level: 'L2', bomParent: 'VENDA-CARNE', via: 'SUB-TEMPERO', contribution: 0.0010 }],
    },
  ];

  test('returns valid HTML', () => {
    const html = buildCase2AlertEmail(errors);
    expect(html).toMatch(/<html/i);
    expect(html).toMatch(/<\/html>/i);
  });

  test('includes item codes and names', () => {
    const html = buildCase2AlertEmail(errors);
    expect(html).toContain('500720');
    expect(html).toContain('Azeite');
    expect(html).toContain('300010');
    expect(html).toContain('Sal Grosso');
  });

  test('shows L1 BOM parent to remove', () => {
    const html = buildCase2AlertEmail(errors);
    expect(html).toContain('VENDA-RISOTO');
  });

  test('shows L2 sub-recipe (via) to remove', () => {
    const html = buildCase2AlertEmail(errors);
    expect(html).toContain('SUB-TEMPERO');
  });

  test('deduplicates same (itemCode, bomParent) across stores', () => {
    const duplicated = [
      {
        itemCode: '500720', itemName: 'Azeite', store: '6 - Citta', errorDates: ['10/07/2026'],
        bomRows: [{ level: 'L1', bomParent: 'VENDA-RISOTO', via: null, contribution: 0.0049 }],
      },
      {
        itemCode: '500720', itemName: 'Azeite', store: '7 - Delitrop', errorDates: ['11/07/2026'],
        bomRows: [{ level: 'L1', bomParent: 'VENDA-RISOTO', via: null, contribution: 0.0049 }],
      },
    ];
    const html = buildCase2AlertEmail(duplicated);
    // ficha section: itemCode+bomParent should appear once, not twice
    const codeOccurrences = (html.match(/>500720</g) || []).length;
    expect(codeOccurrences).toBe(1);
  });
});

describe('buildCase2ActionEmail', () => {
  const results = [
    { itemCode: '500720', itemName: 'Azeite', bomParent: 'VENDA-RISOTO', success: true },
    { itemCode: '300010', itemName: 'Sal Grosso', bomParent: 'VENDA-CARNE', success: false, error: 'SAP timeout' },
  ];

  test('returns valid HTML', () => {
    const html = buildCase2ActionEmail(results);
    expect(html).toMatch(/<html/i);
  });

  test('shows success marker', () => {
    expect(buildCase2ActionEmail(results)).toContain('✅');
  });

  test('shows failure marker and error message', () => {
    const html = buildCase2ActionEmail(results);
    expect(html).toContain('❌');
    expect(html).toContain('SAP timeout');
  });

  test('summary counts: 1 removed, 1 failed', () => {
    const html = buildCase2ActionEmail(results);
    expect(html).toContain('<strong>1</strong>');
    expect(html).toContain('1 falha(s)');
  });

  test('all success — no failure line', () => {
    const allOk = [{ itemCode: '500720', itemName: 'Azeite', bomParent: 'VENDA-RISOTO', success: true }];
    const html = buildCase2ActionEmail(allOk);
    expect(html).not.toContain('falha(s)');
  });
});

describe('buildCase3AllClearEmail', () => {
  test('returns valid HTML with green theme', () => {
    const html = buildCase3AllClearEmail();
    expect(html).toMatch(/<html/i);
    expect(html).toContain('27ae60');
  });

  test('contains all-clear message', () => {
    expect(buildCase3AllClearEmail()).toContain('Tudo limpo');
  });
});

describe('buildCase3Email', () => {
  const rows = [
    { itemCode: '500720', itemName: 'Azeite', contribution: 0.0010, minPrice: 15.0, level: 'L1', bomParent: 'VENDA-RISOTO', via: null },
    { itemCode: '300010', itemName: 'Sal', contribution: 0.0001, minPrice: 2.0, level: 'L2', bomParent: 'VENDA-SALMAO', via: 'SUB-TEMPERO' },
  ];

  test('returns valid HTML', () => {
    const html = buildCase3Email(rows);
    expect(html).toMatch(/<html/i);
    expect(html).toMatch(/<\/html>/i);
  });

  test('includes item codes and names', () => {
    const html = buildCase3Email(rows);
    expect(html).toContain('500720');
    expect(html).toContain('Azeite');
    expect(html).toContain('300010');
    expect(html).toContain('Sal');
  });

  test('groups rows by itemCode — no duplicate product entries', () => {
    const sameProduct = [
      { itemCode: '500720', itemName: 'Azeite', contribution: 0.001, minPrice: 15, level: 'L1', bomParent: 'FICHA-A', via: null },
      { itemCode: '500720', itemName: 'Azeite', contribution: 0.002, minPrice: 15, level: 'L1', bomParent: 'FICHA-B', via: null },
    ];
    const html = buildCase3Email(sameProduct);
    // product 500720 should appear in one row block, both fichas listed inside
    expect(html).toContain('FICHA-A');
    expect(html).toContain('FICHA-B');
    const tdOccurrences = (html.match(/>500720</g) || []).length;
    expect(tdOccurrences).toBe(1);
  });
});
