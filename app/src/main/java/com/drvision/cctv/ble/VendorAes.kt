package com.drvision.cctv.ble

import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Mirrors com.macrovideo.v380pro.utils.Aes: AES with the vendor default key/iv "1234567890123456".
 * Used to wrap the Wi-Fi credential (bindinfo) — the exact packing is the one unconfirmed detail
 * (see ble-first-setup-protocol.md §6); encodeCbcHex is the strongest hypothesis.
 */
object VendorAes {
    private const val KEY = "1234567890123456"

    private fun hex(b: ByteArray): String {
        val sb = StringBuilder(b.size * 2)
        for (x in b) { val h = Integer.toHexString(x.toInt() and 0xff); if (h.length == 1) sb.append('0'); sb.append(h.uppercase()) }
        return sb.toString()
    }

    /** hex(AES/CBC/PKCS5(plain, key=iv="1234567890123456")) */
    fun encodeCbcHex(plain: String): String {
        val k = SecretKeySpec(KEY.toByteArray(), "AES")
        val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
        c.init(Cipher.ENCRYPT_MODE, k, IvParameterSpec(KEY.toByteArray()))
        return hex(c.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }

    /** hex(AES/ECB/PKCS5(plain, key="1234567890123456")) — Aes.encode() */
    fun encodeEcbHex(plain: String): String {
        val k = SecretKeySpec(KEY.toByteArray(), "AES")
        val c = Cipher.getInstance("AES/ECB/PKCS5Padding")
        c.init(Cipher.ENCRYPT_MODE, k)
        return hex(c.doFinal(plain.toByteArray(Charsets.UTF_8)))
    }
}
