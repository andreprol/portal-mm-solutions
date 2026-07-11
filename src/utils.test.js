'use strict';

const { portalDateToIso, storeToWhsCode, minDate, maxDate } = require('./utils');
const { parseZeroCostErrors } = require('./manyfood');

// ---------------------------------------------------------------------------
// portalDateToIso
// ---------------------------------------------------------------------------
describe('portalDateToIso', () => {
  test('converts 01/06/2026 to 2026-06-01', () => {
    expect(portalDateToIso('01/06/2026')).toBe('2026-06-01');
  });

  test('converts 31/12/2025 to 2025-12-31', () => {
    expect(portalDateToIso('31/12/2025')).toBe('2025-12-31');
  });

  test('preserves zero-padded single-digit day and month (05/07/2026)', () => {
    expect(portalDateToIso('05/07/2026')).toBe('2026-07-05');
  });

  test('converts 15/01/2024 to 2024-01-15', () => {
    expect(portalDateToIso('15/01/2024')).toBe('2024-01-15');
  });
});

// ---------------------------------------------------------------------------
// storeToWhsCode
// ---------------------------------------------------------------------------
describe('storeToWhsCode', () => {
  test('extracts and pads single-digit prefix "6 - Cittá Delirio Restaurante" → "06"', () => {
    expect(storeToWhsCode('6 - Cittá Delirio Restaurante')).toBe('06');
  });

  test('returns two-digit string for two-digit prefix "14 - Delirio Tropical Niteroi Plaza" → "14"', () => {
    expect(storeToWhsCode('14 - Delirio Tropical Niteroi Plaza')).toBe('14');
  });

  test('pads single-digit "1 - Loja Um" → "01"', () => {
    expect(storeToWhsCode('1 - Loja Um')).toBe('01');
  });

  test('returns null for name without leading number', () => {
    expect(storeToWhsCode('invalid name without number')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(storeToWhsCode('')).toBeNull();
  });

  test('returns null for " - no digits" (dash only, no leading digit)', () => {
    expect(storeToWhsCode(' - no digits')).toBeNull();
  });

  test('handles two-digit prefix "10 - Store Ten" → "10"', () => {
    expect(storeToWhsCode('10 - Store Ten')).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// minDate
// ---------------------------------------------------------------------------
describe('minDate', () => {
  test('returns earlier date when first arg is earlier', () => {
    expect(minDate('01/06/2026', '15/06/2026')).toBe('01/06/2026');
  });

  test('returns earlier date across year boundary', () => {
    expect(minDate('31/12/2025', '01/01/2026')).toBe('31/12/2025');
  });

  test('returns first arg when both dates are equal', () => {
    expect(minDate('10/07/2026', '10/07/2026')).toBe('10/07/2026');
  });

  test('returns later arg as min when first arg is actually later', () => {
    expect(minDate('15/06/2026', '01/06/2026')).toBe('01/06/2026');
  });
});

// ---------------------------------------------------------------------------
// maxDate
// ---------------------------------------------------------------------------
describe('maxDate', () => {
  test('returns later date when second arg is later', () => {
    expect(maxDate('01/06/2026', '15/06/2026')).toBe('15/06/2026');
  });

  test('returns later date across year boundary', () => {
    expect(maxDate('31/12/2025', '01/01/2026')).toBe('01/01/2026');
  });

  test('returns first arg when both dates are equal', () => {
    expect(maxDate('10/07/2026', '10/07/2026')).toBe('10/07/2026');
  });

  test('returns first arg as max when first arg is actually later', () => {
    expect(maxDate('15/06/2026', '01/06/2026')).toBe('15/06/2026');
  });
});

// ---------------------------------------------------------------------------
// parseZeroCostErrors
// ---------------------------------------------------------------------------
describe('parseZeroCostErrors', () => {
  test('returns empty array for empty input', () => {
    expect(parseZeroCostErrors([])).toEqual([]);
  });

  test('parses a single matching error correctly', () => {
    const errors = [
      {
        erro: "O item '1234':'Frango Grelhado' está sem custo",
        filiais: 'Loja Central',
        data: '01/07/2026',
        empresaGestora: 'Delirio Tropical',
      },
    ];
    const result = parseZeroCostErrors(errors);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      itemCode: '1234',
      itemName: 'Frango Grelhado',
      store: 'Loja Central',
      date: '01/07/2026',
      managingCompany: 'Delirio Tropical',
    });
  });

  test('returns empty array when error does not match the pattern', () => {
    const errors = [
      { erro: 'Outro tipo de erro qualquer', filiais: 'X', data: '01/07/2026', empresaGestora: 'Y' },
    ];
    expect(parseZeroCostErrors(errors)).toEqual([]);
  });

  test('filters out non-matching errors, keeps matching ones', () => {
    const errors = [
      { erro: 'Erro irrelevante', filiais: 'A', data: '01/07/2026', empresaGestora: 'Z' },
      {
        erro: "O item '9999':'Pizza Margherita' está sem custo",
        filiais: 'Filial Norte',
        data: '02/07/2026',
        empresaGestora: 'Cia Norte',
      },
      { erro: 'Outro erro', filiais: 'B', data: '03/07/2026', empresaGestora: 'W' },
    ];
    const result = parseZeroCostErrors(errors);
    expect(result).toHaveLength(1);
    expect(result[0].itemCode).toBe('9999');
    expect(result[0].itemName).toBe('Pizza Margherita');
  });

  test('parses multiple matching errors', () => {
    const errors = [
      {
        erro: "O item '0001':'Item A' está sem custo",
        filiais: 'Loja 1',
        data: '01/06/2026',
        empresaGestora: 'Empresa A',
      },
      {
        erro: "O item '0002':'Item B' está sem custo",
        filiais: 'Loja 2',
        data: '02/06/2026',
        empresaGestora: 'Empresa B',
      },
    ];
    const result = parseZeroCostErrors(errors);
    expect(result).toHaveLength(2);
    expect(result[0].itemCode).toBe('0001');
    expect(result[1].itemCode).toBe('0002');
  });

  test('extracts itemCode and itemName correctly from Portuguese string', () => {
    const errors = [
      {
        erro: "O item '42':'Bife com Batatas Fritas' está sem custo",
        filiais: 'Filial Sul',
        data: '10/07/2026',
        empresaGestora: 'Sul Corp',
      },
    ];
    const result = parseZeroCostErrors(errors);
    expect(result[0].itemCode).toBe('42');
    expect(result[0].itemName).toBe('Bife com Batatas Fritas');
  });

  test('handles missing optional fields gracefully (store and managingCompany default to empty string)', () => {
    const errors = [
      {
        erro: "O item '777':'Suco Natural' está sem custo",
      },
    ];
    const result = parseZeroCostErrors(errors);
    expect(result).toHaveLength(1);
    expect(result[0].store).toBe('');
    expect(result[0].date).toBe('');
    expect(result[0].managingCompany).toBe('');
  });
});
