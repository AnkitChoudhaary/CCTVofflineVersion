package com.drvision.cctv

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.*
import com.drvision.cctv.ble.BleProvisioner
import com.drvision.cctv.ble.QrInfo
import com.google.zxing.integration.android.IntentIntegrator

@SuppressLint("MissingPermission", "SetTextI18n")
class BleSetupActivity : Activity() {

    private lateinit var statusQr: TextView
    private lateinit var ssidInput: EditText
    private lateinit var pwdInput: EditText
    private lateinit var deviceList: LinearLayout
    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView

    private var qr: QrInfo? = null
    private var provisioner: BleProvisioner? = null
    private val seen = HashSet<String>()
    private var scanning = false
    private val h = Handler(Looper.getMainLooper())

    private val scanner by lazy {
        (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter?.bluetoothLeScanner
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pad = dp(16)
        scroll = ScrollView(this)
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(pad, pad, pad, pad); setBackgroundColor(0xFF0E1116.toInt()) }
        scroll.addView(root)
        setContentView(scroll)

        root.addView(title("Add camera via Bluetooth"))
        root.addView(hint("1. Scan the QR code printed on the camera (new-platform V380/Dr.Vision)."))
        root.addView(button("📷  Scan camera QR") { startQrScan() })
        statusQr = hint("No QR scanned yet."); root.addView(statusQr)

        root.addView(space())
        root.addView(hint("2. Wi-Fi the camera should join (your phone hotspot)."))
        ssidInput = input("Wi-Fi name (SSID)", false); root.addView(ssidInput)
        pwdInput = input("Wi-Fi password", true); root.addView(pwdInput)

        root.addView(space())
        root.addView(hint("3. Find the camera over Bluetooth and connect."))
        root.addView(button("🔍  Find camera over Bluetooth") { ensureBlePerms { startBleScan() } })
        deviceList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }; root.addView(deviceList)

        root.addView(space())
        logView = TextView(this).apply { setTextColor(0xFF8A97A6.toInt()); textSize = 12f; setPadding(0, dp(8), 0, 0) }
        root.addView(logView)
    }

    // ---------- QR ----------
    private fun startQrScan() {
        IntentIntegrator(this).apply {
            setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            setPrompt("Scan the QR code on the camera")
            setBeepEnabled(true)
            setOrientationLocked(false)
        }.initiateScan()
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val r = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (r != null && r.contents != null) {
            val info = QrInfo.parse(r.contents)
            if (info == null) { statusQr.text = "❌ Not a recognized V380 camera QR."; statusQr.setTextColor(0xFFE05A5A.toInt()); return }
            qr = info
            val bt = if (info.supportsBluetooth) "Bluetooth setup supported" else "⚠ QR does not list Bluetooth setup"
            statusQr.setTextColor(if (info.supportsBluetooth) 0xFF43C08A.toInt() else 0xFFE0B341.toInt())
            statusQr.text = "✓ Camera ${info.deviceId} scanned. $bt. fastPin=${if (info.fastPin.isNotEmpty()) "present" else "none"}."
            log("QR: deviceId=${info.deviceId} configList=${info.configList} fastPin=${if (info.fastPin.isEmpty()) "-" else "present"}")
        } else {
            super.onActivityResult(requestCode, resultCode, data)
        }
    }

    // ---------- BLE scan ----------
    private fun startBleScan() {
        if (qr == null) { toast("Scan the camera QR first."); return }
        if (ssidInput.text.isBlank()) { toast("Enter the Wi-Fi name first."); return }
        val adapter = (getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager).adapter
        if (adapter == null || !adapter.isEnabled) { toast("Turn on Bluetooth first."); return }
        val s = scanner ?: run { toast("BLE not available."); return }
        if (scanning) return
        scanning = true
        seen.clear(); deviceList.removeAllViews()
        log("Scanning for BLE devices (8s)…")
        s.startScan(null, ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(), scanCb)
        h.postDelayed({ stopScan() }, 8000)
    }

    private fun stopScan() {
        if (!scanning) return
        scanning = false
        try { scanner?.stopScan(scanCb) } catch (_: Exception) {}
        if (deviceList.childCount == 0) log("No named BLE devices found. Make sure the camera is in pairing mode and close by.")
    }

    private val scanCb = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            val dev = result.device ?: return
            val name = dev.name ?: return   // show only named devices
            val addr = dev.address ?: return
            if (!seen.add(addr)) return
            runOnUiThread { deviceList.addView(button("Connect to  $name  ($addr)") { stopScan(); connect(dev) }) }
        }
    }

    // ---------- provisioning ----------
    private fun connect(dev: BluetoothDevice) {
        val info = qr ?: return
        provisioner?.stop()
        log("Connecting to ${dev.address} and sending Wi-Fi…")
        provisioner = BleProvisioner(
            this, dev,
            ssidInput.text.toString(), pwdInput.text.toString(),
            info.fastPin, 0L,
            object : BleProvisioner.Listener {
                override fun log(s: String) = this@BleSetupActivity.log(s)
                override fun state(s: String) = runOnUiThread { toast(s) }
                override fun success() = runOnUiThread {
                    toast("Camera added! It should now appear in the app.")
                    setResult(RESULT_OK); finish()
                }
                override fun failure(s: String) = runOnUiThread { this@BleSetupActivity.log("FAILED: $s") }
            }
        )
        provisioner?.start()
    }

    // ---------- permissions ----------
    private var permCb: (() -> Unit)? = null
    private fun ensureBlePerms(onGranted: () -> Unit) {
        val need = ArrayList<String>()
        if (Build.VERSION.SDK_INT >= 31) {
            if (!has(Manifest.permission.BLUETOOTH_SCAN)) need.add(Manifest.permission.BLUETOOTH_SCAN)
            if (!has(Manifest.permission.BLUETOOTH_CONNECT)) need.add(Manifest.permission.BLUETOOTH_CONNECT)
        } else {
            if (!has(Manifest.permission.ACCESS_FINE_LOCATION)) need.add(Manifest.permission.ACCESS_FINE_LOCATION)
        }
        if (need.isEmpty()) onGranted() else { permCb = onGranted; requestPermissions(need.toTypedArray(), 42) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 42) {
            if (grantResults.isNotEmpty() && grantResults.all { it == PackageManager.PERMISSION_GRANTED }) permCb?.invoke()
            else toast("Bluetooth permission is required.")
            permCb = null
        }
    }

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    override fun onDestroy() { provisioner?.stop(); try { scanner?.stopScan(scanCb) } catch (_: Exception) {}; super.onDestroy() }

    // ---------- tiny UI helpers ----------
    private fun log(s: String) = runOnUiThread {
        logView.append((if (logView.text.isEmpty()) "" else "\n") + s)
        h.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }
    private fun toast(s: String) = Toast.makeText(this, s, Toast.LENGTH_SHORT).show()
    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private fun lp() = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(6) }
    private fun title(t: String) = TextView(this).apply { text = t; setTextColor(Color.WHITE); textSize = 20f; setPadding(0, 0, 0, dp(10)) }
    private fun hint(t: String) = TextView(this).apply { text = t; setTextColor(0xFF8A97A6.toInt()); textSize = 13f; layoutParams = lp() }
    private fun space() = View(this).apply { layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(14)) }
    private fun input(hintTxt: String, pwd: Boolean) = EditText(this).apply {
        hint = hintTxt; setHintTextColor(0xFF66727F.toInt()); setTextColor(Color.WHITE); textSize = 15f; layoutParams = lp()
        setBackgroundColor(0xFF1F2630.toInt()); setPadding(dp(12), dp(12), dp(12), dp(12))
        inputType = if (pwd) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT
    }
    private fun button(t: String, onClick: () -> Unit) = Button(this).apply {
        text = t; isAllCaps = false; setTextColor(Color.WHITE); textSize = 15f
        setBackgroundColor(0xFF2A7ADE.toInt()); layoutParams = lp(); setOnClickListener { onClick() }
    }
}
