package com.drvision.cctv.ble

/** V380 BLE setup packet codec: 16-byte "BTNC" SHDR header + payload (little-endian). */
object Shdr {
    const val HEADER = 16
    private val TAG = byteArrayOf('B'.code.toByte(), 'T'.code.toByte(), 'N'.code.toByte(), 'C'.code.toByte())

    // act
    const val ACK = 0
    const val HS_REQ = 1
    const val HS_RSP = 2
    const val NC_REQ = 3
    const val NC_RSP = 4
    const val STATE_REQ = 5
    const val STATE_RSP = 6

    // flag bits
    const val FLAG_NEED_ACK = 1
    const val FLAG_IS_ACK = 2
    const val FLAG_IS_RSP = 4

    private fun u16le(b: ByteArray, off: Int, v: Int) {
        b[off] = (v and 0xff).toByte(); b[off + 1] = ((v ushr 8) and 0xff).toByte()
    }

    fun u16(b: ByteArray, off: Int): Int = (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8)

    fun i32(b: ByteArray, off: Int): Int =
        (b[off].toInt() and 0xff) or ((b[off + 1].toInt() and 0xff) shl 8) or
        ((b[off + 2].toInt() and 0xff) shl 16) or ((b[off + 3].toInt() and 0xff) shl 24)

    fun i64le(v: Long): ByteArray {
        val b = ByteArray(8)
        for (i in 0 until 8) b[i] = ((v ushr (8 * i)) and 0xff).toByte()
        return b
    }

    fun buildFrame(act: Int, sid: Int, flag: Int, msgId: Int, payload: ByteArray,
                   totalSlice: Int = 1, sliceId: Int = 0): ByteArray {
        val out = ByteArray(HEADER + payload.size)
        System.arraycopy(TAG, 0, out, 0, 4)
        out[4] = act.toByte(); out[5] = sid.toByte(); out[6] = flag.toByte()
        u16le(out, 7, payload.size); u16le(out, 9, msgId); u16le(out, 11, totalSlice); u16le(out, 13, sliceId)
        System.arraycopy(payload, 0, out, HEADER, payload.size)
        return out
    }

    data class Frame(
        val act: Int, val sid: Int, val flag: Int, val payloadLen: Int,
        val msgId: Int, val totalSlice: Int, val sliceId: Int, val payload: ByteArray
    ) {
        val needAck get() = (flag and FLAG_NEED_ACK) != 0 && act != ACK && (flag and FLAG_IS_ACK) == 0
        fun code(): Int = if (payload.size >= 4) i32(payload, 0) else -1
    }

    fun parse(b: ByteArray): Frame? {
        if (b.size < HEADER) return null
        if (b[0] != TAG[0] || b[1] != TAG[1] || b[2] != TAG[2] || b[3] != TAG[3]) return null
        val len = u16(b, 7)
        val end = minOf(HEADER + len, b.size)
        return Frame(b[4].toInt() and 0xff, b[5].toInt() and 0xff, b[6].toInt() and 0xff, len,
            u16(b, 9), u16(b, 11), u16(b, 13), b.copyOfRange(HEADER, end))
    }

    /** ACK frame for a received frame that requested one (same msgId, IS_ACK set). */
    fun ackFor(f: Frame): ByteArray =
        buildFrame(ACK, f.sid, FLAG_IS_ACK, f.msgId, ByteArray(0), f.totalSlice, f.sliceId)
}
