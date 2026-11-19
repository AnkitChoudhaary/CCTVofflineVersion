package com.drvision.cctv

/**
 * JNI bridge into the embedded nodejs-mobile runtime (libnode.so).
 * startNodeWithArguments blocks for the lifetime of the Node event loop,
 * so it must be called on a dedicated background thread.
 */
object NodeBridge {
    init {
        // libnode.so first so the bridge's NEEDED dependency resolves, then our bridge.
        System.loadLibrary("node")
        System.loadLibrary("native-lib")
    }

    external fun startNodeWithArguments(arguments: Array<String>): Int
}
