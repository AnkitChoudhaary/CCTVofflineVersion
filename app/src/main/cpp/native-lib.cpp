// JNI bridge that boots the embedded nodejs-mobile runtime.
// Based on the standard nodejs-mobile Android integration (node::Start).
#include <jni.h>
#include <cstring>
#include <cstdlib>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include "node.h"

#define LOG_TAG "NODEJS-MOBILE"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

// ---- redirect Node's stdout/stderr into logcat so console.log is visible ----
static int pfd[2];
static pthread_t logger_thread;

static void *logger_fn(void *) {
    ssize_t n;
    char buf[4096];
    while ((n = read(pfd[0], buf, sizeof(buf) - 1)) > 0) {
        if (n > 0 && buf[n - 1] == '\n') --n;
        buf[n] = 0;
        __android_log_write(ANDROID_LOG_INFO, LOG_TAG, buf);
    }
    return nullptr;
}

static void start_stdout_logger() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pfd);
    dup2(pfd[1], STDOUT_FILENO);
    dup2(pfd[1], STDERR_FILENO);
    pthread_create(&logger_thread, nullptr, logger_fn, nullptr);
    pthread_detach(logger_thread);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_drvision_cctv_NodeBridge_startNodeWithArguments(
        JNIEnv *env, jobject /*thiz*/, jobjectArray arguments) {

    start_stdout_logger();

    jsize argc = env->GetArrayLength(arguments);

    // Measure total length for a single contiguous argv buffer.
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }

    char *buffer = (char *) calloc(total, 1);
    char **argv = (char **) calloc(argc + 1, sizeof(char *));
    char *p = buffer;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring) env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        size_t len = strlen(c);
        memcpy(p, c, len);
        argv[i] = p;
        p += len + 1;
        env->ReleaseStringUTFChars(s, c);
        env->DeleteLocalRef(s);
    }
    argv[argc] = nullptr;

    LOGI("node::Start argc=%d entry=%s", (int) argc, argc > 1 ? argv[1] : "(none)");
    int result = node::Start((int) argc, argv);
    LOGE("node::Start returned %d (event loop ended)", result);

    free(buffer);
    free(argv);
    return (jint) result;
}
