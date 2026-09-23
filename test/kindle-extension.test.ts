import { describe, expect, it } from 'vitest';
import {
  parseCsrfToken,
  parseOwnershipData,
  parseRegisterResponseXml,
  registrationBody,
  xmlField,
} from '../extension/lib.mjs';

describe('registration + XML parsing', () => {
  it('builds the registration body with escaped fields', () => {
    const body = registrationBody({
      email: 'a&b@example.com',
      password: 'x<y',
      serial: 's'.repeat(40),
      deviceName: 'CrossPoint Sync',
      deviceType: 'A3VNNDO1I14V03',
      softwareVersion: '1124597795',
    });
    expect(body).toContain('<email>a&amp;b@example.com</email>');
    expect(body).toContain('<password>x&lt;y</password>');
    expect(body).toContain(`<deviceSerialNumber>${'s'.repeat(40)}</deviceSerialNumber>`);
  });

  it('parses the register response, CDATA-tolerant', () => {
    const xml =
      '<response><adp_token><![CDATA[tok123]]></adp_token><device_private_key>a2V5</device_private_key>' +
      '<user_device_name>CrossPoint Sync</user_device_name></response>';
    expect(parseRegisterResponseXml(xml)).toEqual({
      adpToken: 'tok123',
      privateKey: 'a2V5',
      deviceName: 'CrossPoint Sync',
    });
  });

  it('throws Amazon’s message when no credential is returned', () => {
    expect(() => parseRegisterResponseXml('<response><message>bad code</message></response>')).toThrow('bad code');
  });

  it('xmlField extracts plain and empty values', () => {
    expect(xmlField('<a><b> x </b></a>', 'b')).toBe('x');
    expect(xmlField('<a/>', 'b')).toBe('');
  });
});

describe('MYCD parsing', () => {
  it('extracts csrfToken in both page shapes', () => {
    expect(parseCsrfToken('<script>var csrfToken = "tok123";</script>')).toBe('tok123');
    expect(parseCsrfToken('<script>window.csrfToken = "tok456"</script>')).toBe('tok456');
    expect(parseCsrfToken('<html>nothing</html>')).toBeNull();
  });

  it('normalizes the ownership payload with pagination total', () => {
    const json = {
      GetContentOwnershipDataResponse: {
        ownershipData: {
          numberOfItems: 3,
          items: [
            { asin: 'B0PDOC1', title: 'Doc One', authors: 'Writer One' },
            { asin: 'B0PDOC2', title: 'Doc Two', authors: ['A', 'B'] },
            { asin: '', title: 'skip me' },
          ],
        },
      },
    };
    expect(parseOwnershipData(json)).toEqual({
      total: 3,
      items: [
        { asin: 'B0PDOC1', title: 'Doc One', author: 'Writer One', type: 'PDOC' },
        { asin: 'B0PDOC2', title: 'Doc Two', author: 'A, B', type: 'PDOC' },
      ],
    });
  });

  it('tolerates alternate payload shapes', () => {
    expect(parseOwnershipData({ items: [{ ASIN: 'X1', title: 'T' }] }).items[0].asin).toBe('X1');
    expect(parseOwnershipData({}).items).toEqual([]);
  });
});
