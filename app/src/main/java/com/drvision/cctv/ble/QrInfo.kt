package com.drvision.cctv.ble

import org.json.JSONObject

/** Parses a V380 device QR. New-platform format: "HSC^{json}" with stringified-int keys. */
class QrInfo private constructor(
    val raw: String,
    val isNewPlatform: Boolean,
    val deviceId: Int,
    val configList: Int,
    val fastPin: String,
    val pwd: String
) {
    val supportsBluetooth get() = (configList and CONFIG_BLUETOOTH) != 0

    companion object {
        const val PREFIX_NEW = "HSC^"
        const val PREFIX_OLD = "V380^"
        const val CONFIG_AP = 1
        const val CONFIG_QR = 2
        const val CONFIG_WPS = 32
        const val CONFIG_BLUETOOTH = 64
        const val CONFIG_PIN_CODE = 256

        fun parse(content: String?): QrInfo? {
            if (content.isNullOrBlank()) return null
            // case-swap obfuscation: lowercase "v380^" prefix -> swap case of all letters
            var s = content.trim()
            if (s.startsWith("v380^")) s = s.map { if (it.isLetter()) if (it.isUpperCase()) it.lowercaseChar() else it.uppercaseChar() else it }.joinToString("")
            if (!s.startsWith(PREFIX_NEW)) return null
            val parts = s.split("^")
            if (parts.size < 2) return null
            return try {
                val j = JSONObject(parts[1])
                QrInfo(
                    raw = content,
                    isNewPlatform = true,
                    deviceId = j.optInt("1"),
                    configList = j.optInt("5"),
                    fastPin = j.optString("7"),
                    pwd = j.optString("8")
                )
            } catch (e: Exception) { null }
        }
    }
}
