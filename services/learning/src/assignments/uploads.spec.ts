import { checkUpload, checkUploads, MAX_FILE_BYTES, MAX_FILES, safeFileName, UploadError } from './uploads.js';

const b64 = (b: Buffer | string) => (typeof b === 'string' ? Buffer.from(b, 'utf8') : b).toString('base64');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR....')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF')]);

describe('submission uploads', () => {
  it('stores text and code as plain text, whatever the extension', () => {
    const f = checkUpload({ name: 'solution.py', contentBase64: b64('print("hi")\n') });
    expect(f).toMatchObject({ name: 'solution.py', category: 'text', mediaType: 'text/plain; charset=utf-8', size: 12 });
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    // HTML is accepted as source text but will only ever be served as text/plain
    expect(checkUpload({ name: 'page.html', contentBase64: b64('<script>alert(1)</script>') }).mediaType).toBe('text/plain; charset=utf-8');
  });

  it('decides image and PDF types from the bytes, not from the name', () => {
    expect(checkUpload({ name: 'photo.png', contentBase64: b64(PNG) }).mediaType).toBe('image/png');
    expect(checkUpload({ name: 'photo.jpg', contentBase64: b64(JPEG) }).mediaType).toBe('image/jpeg');
    expect(checkUpload({ name: 'notes.pdf', contentBase64: b64('%PDF-1.7\n%...') }).category).toBe('pdf');
    expect(() => checkUpload({ name: 'photo.png', contentBase64: b64(JPEG) })).toThrow(/not a PNG image/);
    expect(() => checkUpload({ name: 'fake.pdf', contentBase64: b64('<html>') })).toThrow(/not a PDF/);
  });

  it('refuses executables, archives and binaries even when renamed', () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64, 0x41)]);
    expect(() => checkUpload({ name: 'readme.txt', contentBase64: b64(exe) })).toThrow(/Windows executable/);
    expect(() => checkUpload({ name: 'run.sh', contentBase64: b64(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) })).toThrow(/ELF/);
    expect(() => checkUpload({ name: 'report.txt', contentBase64: b64(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])) })).toThrow(/ZIP/);
    expect(() => checkUpload({ name: 'a.exe', contentBase64: b64('hello') })).toThrow(/\.exe files are not accepted/);
    expect(() => checkUpload({ name: 'image.svg', contentBase64: b64('<svg/>') })).toThrow(/\.svg files are not accepted/);
    expect(() => checkUpload({ name: 'noext', contentBase64: b64('hello') })).toThrow(/not accepted/);
    expect(() => checkUpload({ name: 'bin.txt', contentBase64: b64(Buffer.from([0x61, 0x00, 0x62])) })).toThrow(/binary data/);
    expect(() => checkUpload({ name: 'latin1.txt', contentBase64: b64(Buffer.from([0x63, 0x61, 0x66, 0xe9])) })).toThrow(/UTF-8/);
  });

  it('enforces size, count and encoding limits', () => {
    expect(() => checkUpload({ name: 'big.txt', contentBase64: b64(Buffer.alloc(MAX_FILE_BYTES + 1, 0x61)) })).toThrow(/larger than 2 MB/);
    expect(checkUpload({ name: 'max.txt', contentBase64: b64(Buffer.alloc(MAX_FILE_BYTES, 0x61)) }).size).toBe(MAX_FILE_BYTES);
    expect(() => checkUpload({ name: 'empty.txt', contentBase64: '' })).toThrow(/empty/);
    expect(() => checkUpload({ name: 'x.txt', contentBase64: 'not base64!' })).toThrow(/base64/);
    const one = { name: 'a.txt', contentBase64: b64('a') };
    expect(() => checkUploads(Array(MAX_FILES + 1).fill(one))).toThrow(UploadError);
    const big = { name: 'b.txt', contentBase64: b64(Buffer.alloc(MAX_FILE_BYTES, 0x61)) };
    expect(() => checkUploads([big, big, big, big])).toThrow(/together are larger/);
    expect(checkUploads([one, one]).map((f) => f.name)).toEqual(['a.txt', 'a (2).txt']);
  });

  it('reduces names to a safe display name', () => {
    expect(safeFileName('../../etc/passwd.txt')).toBe('passwd.txt');
    expect(safeFileName('C:\\Users\\me\\answer.md')).toBe('answer.md');
    expect(safeFileName('evil\u202egnp.txt')).toBe('evilgnp.txt');
    expect(safeFileName('a\u0000b<>:"|?*.txt')).toBe('ab.txt');
    expect(safeFileName('...')).toBe('file');
    expect(safeFileName('정답 노트.md')).toBe('정답 노트.md');
    const long = safeFileName(`${'x'.repeat(300)}.py`);
    expect(long).toHaveLength(120);
    expect(long.endsWith('.py')).toBe(true);
  });
});
