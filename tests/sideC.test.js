const { classifyCatalyst } = require('../src/sideC/news');

describe('Side C — Catalyst Classification', () => {
  test('FDA approval headline → FDA Approval', () => {
    const r = classifyCatalyst(['Company receives FDA approval for drug XYZ']);
    expect(r).not.toBeNull();
    expect(r.label).toBe('FDA Approval');
    expect(r.sentiment).toBe('bull');
  });

  test('FDA CRL headline → FDA Rejection', () => {
    const r = classifyCatalyst(['Company receives FDA CRL for proposed drug']);
    expect(r.label).toBe('FDA Rejection');
    expect(r.sentiment).toBe('bear');
  });

  test('earnings beat → Earnings Beat', () => {
    const r = classifyCatalyst(['Company reports earnings beat of analyst estimates']);
    expect(r.label).toBe('Earnings Beat');
    expect(r.sentiment).toBe('bull');
  });

  test('earnings miss → Earnings Miss', () => {
    const r = classifyCatalyst(['Company reports earnings miss']);
    expect(r.label).toBe('Earnings Miss');
    expect(r.sentiment).toBe('bear');
  });

  test('acquisition → M&A (bull)', () => {
    const r = classifyCatalyst(['Company announces acquisition of rival']);
    expect(r.label).toBe('M&A');
    expect(r.sentiment).toBe('bull');
  });

  test('offering → Dilution (bear)', () => {
    const r = classifyCatalyst(['Company announces secondary offering of shares']);
    expect(r.label).toBe('Dilution');
    expect(r.sentiment).toBe('bear');
  });

  test('higher priority wins', () => {
    // FDA approval (priority 1) vs M&A (priority 5)
    const r = classifyCatalyst(['Company gets FDA approval and announces acquisition']);
    expect(r.label).toBe('FDA Approval');
  });

  test('no match → null', () => {
    const r = classifyCatalyst(['Company announces quarterly dividend']);
    expect(r).toBeNull();
  });

  test('lawsuit → Legal Risk (bear)', () => {
    const r = classifyCatalyst(['Company faces lawsuit from class action attorneys']);
    expect(r.label).toBe('Legal Risk');
    expect(r.sentiment).toBe('bear');
  });
});
