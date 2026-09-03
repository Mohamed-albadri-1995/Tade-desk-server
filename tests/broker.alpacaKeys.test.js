/*
 * AN ACCOUNT'S OWN ALPACA KEYS, AND THE FORM THAT NEVER HAD THE FIELD.
 *
 * The desk holds ONE shared Alpaca pair beside the accounts. That pair answers
 * for one account, and while there is a single Alpaca destination it
 * unambiguously IS that one. The moment there are two, nothing can say which —
 * so `reconcile.credentialScope()` refuses both BY NAME and the journal shows
 * neither account's fills.
 *
 * The server has accepted, validated and masked per-destination keys since
 * accounts existed. The form never had the field, so there was no way to give
 * an account its keys and the refusal could not be cleared. Reported plainly,
 * after being told to go and enter them:
 *
 *     "I didn't even enter the key and secret because this option is not exist"
 *
 * A backend that is ready and a form that cannot reach it is the same as no
 * feature — and worse, because everything downstream reports it as the user's
 * configuration mistake.
 */

const fs = require('fs');
const path = require('path');

const page = fs.readFileSync(path.join(__dirname, '../public/alerts.html'), 'utf8');
const script = page;

/** The real readDests(), run against a hand-built stand-in for the DOM. */
function liftReadDests(rows) {
  const src = script.match(/function readDests\(\)[\s\S]*?\n\}/)[0];
  const el = (attrs, values, chips = []) => ({
    getAttribute: (k) => (k in attrs ? attrs[k] : null),
    querySelector: (sel) => {
      const cls = sel.replace(/^\./, '');
      return cls in values ? { value: values[cls] } : null;
    },
    querySelectorAll: () => chips,
  });
  const nodes = rows.map(r => el(r.attrs, r.values, r.chips || []));
  const document = { querySelectorAll: () => nodes };
  // eslint-disable-next-line no-new-func
  return new Function('document', `${src}\nreturn readDests();`)(document);
}

const ALPACA = {
  attrs: { 'data-id': 'algo-a', 'data-dialect': 'alpaca', 'data-off': '0' },
  values: { 'd-name': 'Algo A', 'd-mode': 'auto' },
};

describe('the destination form can give an account its own Alpaca keys', () => {
  test('the fields exist at all — this is the whole bug', () => {
    expect(script).toContain('d-akey-i');
    expect(script).toContain('d-asec-i');
  });

  test('they are shown only for Alpaca accounts', () => {
    // A TTP or SignalStack destination has no Alpaca credentials to give.
    expect(script).toContain("d.dialect !== 'alpaca' ? '' :");
  });

  test('a typed key and secret reach the save payload', () => {
    const [d] = liftReadDests([{
      ...ALPACA,
      values: { ...ALPACA.values,
                'd-akey-i': 'PKTESTKEYIDAAAAAAAAA',
                'd-asec-i': 'testsecretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
    }]);
    expect(d.alpacaKeyId).toBe('PKTESTKEYIDAAAAAAAAA');
    expect(d.alpacaSecret).toBe('testsecretAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  /*
   * BLANK MEANS KEEP, NOT CLEAR. The secret is never sent back to this page,
   * so a blank box is exactly what an unchanged account looks like. Treating
   * it as a deletion would wipe every account's credentials each time any row
   * was saved — and the page would look like it had done nothing.
   */
  test('blank boxes are OMITTED, so an untouched account keeps its keys', () => {
    const [d] = liftReadDests([ALPACA]);
    expect('alpacaKeyId' in d).toBe(false);
    expect('alpacaSecret' in d).toBe(false);
  });

  test('...which is the same contract the webhook already uses', () => {
    expect(script).toContain('omitted entirely = keep what is stored');
    const [d] = liftReadDests([ALPACA]);
    expect('webhookUrl' in d).toBe(false);
  });

  test('whitespace around a pasted key is trimmed before it is sent', () => {
    // A key pasted with a trailing space fails at the first request with a
    // 401, hours later, in a log nobody is reading.
    const [d] = liftReadDests([{
      ...ALPACA,
      values: { ...ALPACA.values, 'd-akey-i': '  PKTESTKEYIDAAAAAAAAA  ' },
    }]);
    expect(d.alpacaKeyId).toBe('PKTESTKEYIDAAAAAAAAA');
  });

  test('the other fields still come through unchanged', () => {
    const [d] = liftReadDests([{
      ...ALPACA,
      values: { ...ALPACA.values, 'd-maxtrades': '4', 'd-power': '20000' },
    }]);
    expect(d).toMatchObject({ id: 'algo-a', dialect: 'alpaca', enabled: true,
                              maxTradesPerDay: '4', buyingPower: '20000' });
  });

  test('an account with no keys of its own is TOLD so, on the row', () => {
    // Silence here reads as "configured". The consequence is specific and
    // belongs where the account is edited, not in a status page elsewhere.
    expect(script).toContain('No keys of its own');
    expect(script).toContain('cannot be attributed to it');
  });

  test('the secret box is a password field and never autofilled', () => {
    const at = script.indexOf('d-asec-i');
    const around = script.slice(at - 200, at + 200);
    expect(around).toContain('type="password"');
    expect(around).toContain('autocomplete="new-password"');
  });

  test('the stored key id is shown MASKED, and the secret not at all', () => {
    /*
     * What comes back from the server is maskId(alpacaKeyId) with the secret
     * stripped entirely, so the page COULD not render a real secret even if
     * it tried. What it must not do is put either into an input `value`,
     * where a masked id would be saved back as though it were the key.
     *
     * SCOPED TO THE PAINT, not the whole file: the save path writes
     * `d.alpacaSecret = asec` onto the OUTGOING payload, which is the feature
     * working. An assertion over the whole script cannot tell a write to the
     * server from a read of it — the first version of this test could not,
     * and failed on the line that makes the field work.
     */
    const from = script.indexOf('function paintDests(');
    const paint = script.slice(from, script.indexOf('function readDests(', from));
    expect(paint).toContain('d-akey-i');            // the field is in the paint
    expect(paint).not.toMatch(/value="\$\{esc\(d\.alpacaKeyId/);
    expect(paint).not.toContain('d.alpacaSecret');  // never rendered
  });

  test('the reason the desk-wide pair stops working is recorded', () => {
    expect(script).toContain('answers for one account');
  });
});
