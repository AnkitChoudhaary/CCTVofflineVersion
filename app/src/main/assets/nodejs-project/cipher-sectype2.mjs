// Body cipher for V380 Pro IoT/LAN protocol, recovered from libhsMediaLibrary.so +
// libHSMbedtls.so via Ghidra (mvt_cipher_start @libHSMbedtls 0x10e3f8):
//   Protocol.cipherJsonData splits the 32-byte key -> AES key = key[0:16], IV = key[16:32].
//   secureType 2 -> mbedtls_cipher_info_from_type(5) = AES-128-CBC, setkey 128 bits,
//                   set_iv 16, padding mode 0 = PKCS7.
//   secureType 1 -> type 2 = AES-128-ECB, 128-bit key, no IV, PKCS7 padding.
//   op (1st arg): 1 = encrypt, 0 = decrypt.
import crypto from 'node:crypto';

function keyIv(key32) {
  if (!key32 || key32.length < 32) throw new Error('cipher key must be >= 32 bytes');
  return { key: key32.subarray(0, 16), iv: key32.subarray(16, 32) };
}

export function encrypt(plain, key32, secureType = 2) {
  const { key, iv } = keyIv(key32);
  const algo = secureType === 1 ? 'aes-128-ecb' : 'aes-128-cbc';
  const c = secureType === 1 ? crypto.createCipheriv(algo, key, null) : crypto.createCipheriv(algo, key, iv);
  c.setAutoPadding(true); // PKCS7, matches mbedtls padding mode 0
  return Buffer.concat([c.update(plain), c.final()]);
}

export function decrypt(enc, key32, secureType = 2) {
  const { key, iv } = keyIv(key32);
  const algo = secureType === 1 ? 'aes-128-ecb' : 'aes-128-cbc';
  const d = secureType === 1 ? crypto.createDecipheriv(algo, key, null) : crypto.createDecipheriv(algo, key, iv);
  d.setAutoPadding(true);
  return Buffer.concat([d.update(enc), d.final()]);
}
