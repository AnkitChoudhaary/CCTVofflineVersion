package com.drvision.cctv.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/**
 * Drives the V380 BLE Wi-Fi provisioning handshake against one camera.
 * Flow: connect -> discover -> notify+MTU -> HS_REQ -> HS_RSP -> NC_REQ(creds) -> NC_RSP -> poll STATE.
 * Protocol per ble-first-setup-protocol.md (reverse-engineered from V380 Pro 2.2.92).
 */
@SuppressLint("MissingPermission")
class BleProvisioner(
    private val context: Context,
    private val device: BluetoothDevice,
    private val ssid: String,
    private val pwd: String,
    private val fastPin: String,
    private val userId: Long,
    private val cb: Listener
) {
    interface Listener {
        fun log(s: String)
        fun state(s: String)
        fun success()
        fun failure(s: String)
    }

    companion object {
        private const val TAG = "BleProvisioner"
        private val SERVICE = UUID.fromString("0000181C-0000-1000-8000-00805f9b34fb")
        private val WRITE_CH = UUID.fromString("00002a8a-0000-1000-8000-00805f9b34fb")
        private val NOTIFY_CH = UUID.fromString("00002a90-0000-1000-8000-00805f9b34fb")
        private val CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }

    private val h = Handler(Looper.getMainLooper())
    private var gatt: BluetoothGatt? = null
    private var writeCh: BluetoothGattCharacteristic? = null
    private var sid = 0
    private var msgId = 1
    private var mtu = 23
    private var maxPerPacket = 20
    private var finished = false

    private val writeQueue = ArrayDeque<ByteArray>()
    private var writing = false

    private fun nextMsgId(): Int { val i = msgId; msgId = (msgId + 1) and 0xffff; if (msgId == 0) msgId = 1; return i }

    fun start() {
        cb.log("Connecting to ${device.address} …")
        cb.state("Connecting")
        gatt = device.connectGatt(context, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
    }

    fun stop() {
        finished = true
        try { gatt?.disconnect(); gatt?.close() } catch (_: Exception) {}
        gatt = null
    }

    private fun fail(msg: String) {
        if (finished) return
        finished = true
        cb.failure(msg)
        try { gatt?.disconnect(); gatt?.close() } catch (_: Exception) {}
    }

    private fun enqueueWrite(frame: ByteArray) {
        if (frame.size > mtu - 3) {
            cb.log("WARN frame ${frame.size}B > MTU-3 ${mtu - 3}; camera may reject (slicing TODO)")
        }
        writeQueue.addLast(frame); pumpWrites()
    }

    private fun pumpWrites() {
        if (writing) return
        val ch = writeCh ?: return
        val g = gatt ?: return
        val frame = writeQueue.removeFirstOrNull() ?: return
        writing = true
        ch.writeType = if ((ch.properties and BluetoothGattCharacteristic.PROPERTY_WRITE) != 0)
            BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT else BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
        @Suppress("DEPRECATION")
        run { ch.value = frame; g.writeCharacteristic(ch) }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                cb.log("Connected; discovering services…"); cb.state("Discovering")
                h.postDelayed({ g.discoverServices() }, 200)
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                if (!finished) fail("Disconnected (status $status)")
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            val svc = g.getService(SERVICE) ?: return fail("Setup service 0x181C not found — is this a V380 camera in pairing mode?")
            writeCh = svc.getCharacteristic(WRITE_CH) ?: return fail("Write characteristic 0x2A8A missing")
            val notify = svc.getCharacteristic(NOTIFY_CH) ?: return fail("Notify characteristic 0x2A90 missing")
            g.setCharacteristicNotification(notify, true)
            val d = notify.getDescriptor(CCCD)
            if (d != null) {
                @Suppress("DEPRECATION")
                run { d.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE; g.writeDescriptor(d) }
            } else {
                g.requestMtu(512)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            cb.log("Notifications enabled; requesting MTU…")
            g.requestMtu(512)
        }

        override fun onMtuChanged(g: BluetoothGatt, newMtu: Int, status: Int) {
            mtu = newMtu
            cb.log("MTU=$newMtu; sending handshake…"); cb.state("Handshake")
            sendHsReq()
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            writing = false
            if (status != BluetoothGatt.GATT_SUCCESS) cb.log("write status=$status")
            pumpWrites()
        }

        @Deprecated("Deprecated in Java")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            @Suppress("DEPRECATION")
            val bytes = ch.value ?: return
            handleFrame(bytes)
        }
    }

    private fun sendHsReq() {
        val payload = ByteArray(9)
        payload[0] = 1
        System.arraycopy(Shdr.i64le(userId), 0, payload, 1, 8)
        enqueueWrite(Shdr.buildFrame(Shdr.HS_REQ, 0, Shdr.FLAG_NEED_ACK, nextMsgId(), payload))
    }

    private fun handleFrame(bytes: ByteArray) {
        val f = Shdr.parse(bytes) ?: run { cb.log("recv non-SHDR ${bytes.size}B"); return }
        cb.log("recv act=${f.act} sid=${f.sid} code=${if (f.payload.size >= 4) f.code() else -1}")
        if (f.needAck) enqueueWrite(Shdr.ackFor(f))
        when (f.act) {
            Shdr.HS_RSP -> onHsRsp(f)
            Shdr.NC_RSP -> onNcRsp(f)
            Shdr.STATE_RSP -> onStateRsp(f)
            Shdr.ACK -> { /* slice ack */ }
        }
    }

    private fun onHsRsp(f: Shdr.Frame) {
        val p = f.payload
        val code = if (p.size >= 4) Shdr.i32(p, 0) else -1
        if (code != 1000) return fail("Handshake rejected (code $code)")
        sid = f.sid
        if (p.size >= 7) maxPerPacket = Shdr.u16(p, 5)
        cb.log("Handshake OK (sid=$sid, maxPerPacket=$maxPerPacket); sending Wi-Fi credentials…")
        cb.state("Sending Wi-Fi")
        sendNcReq()
    }

    private fun buildBindInfo(): String {
        // HYPOTHESIS (ble-first-setup-protocol.md §6): inner {ssid,pwd} JSON, AES-CBC, vendor key "1234567890123456".
        val inner = JSONObject().put("ssid", ssid).put("pwd", pwd).toString()
        cb.log("bindinfo(plain)=$inner  [format unconfirmed]")
        return VendorAes.encodeCbcHex(inner)
    }

    private fun sendNcReq() {
        // action 2 = pin-code + fast-pin + bindinfo (fast-pin comes from the QR); timeout 0.
        val json = JSONObject()
        json.put("action", 2)
        if (fastPin.isNotEmpty()) json.put("fastpin", fastPin)
        json.put("pincode", 0)
        json.put("bindinfo", buildBindInfo())
        json.put("clicode", userId)
        json.put("timeout", 0)
        val payload = json.toString().toByteArray(Charsets.UTF_8)
        enqueueWrite(Shdr.buildFrame(Shdr.NC_REQ, sid, Shdr.FLAG_NEED_ACK, nextMsgId(), payload))
    }

    private fun onNcRsp(f: Shdr.Frame) {
        val code = if (f.payload.size >= 4) Shdr.i32(f.payload, 0) else -1
        when (code) {
            1000 -> { cb.log("Camera accepted credentials; waiting for it to join Wi-Fi…"); cb.state("Connecting Wi-Fi"); startStatePolling() }
            101 -> fail("Wrong Wi-Fi password (101)")
            else -> fail("Camera rejected credentials (code $code)")
        }
    }

    private fun startStatePolling() {
        var tries = 0
        val poll = object : Runnable {
            override fun run() {
                if (finished) return
                if (tries++ > 30) return fail("Timed out waiting for the camera to join Wi-Fi")
                enqueueWrite(Shdr.buildFrame(Shdr.STATE_REQ, sid, Shdr.FLAG_NEED_ACK, nextMsgId(), ByteArray(0)))
                h.postDelayed(this, 2000)
            }
        }
        h.postDelayed(poll, 1500)
    }

    private fun onStateRsp(f: Shdr.Frame) {
        val p = f.payload
        val code = if (p.size >= 4) Shdr.i32(p, 0) else -1
        val st = if (p.size >= 5) p[4].toInt() and 0xff else -1
        cb.log("state code=$code status=$st")
        if (code == 101 || st == 101) return fail("Wrong Wi-Fi password")
        // status 3 = ConnectingWifi; a higher/positive 'connected' state ends it. Treat code 1000 + non-connecting as done.
        if (code == 1000 && st != 3 && st >= 0 && st != -1 && st != 0) {
            if (finished) return
            finished = true
            cb.log("Camera is online on the network.")
            cb.success()
            try { gatt?.disconnect(); gatt?.close() } catch (_: Exception) {}
        }
    }
}
