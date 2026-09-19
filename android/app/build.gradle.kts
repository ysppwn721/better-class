/* ============================================================================
 * android/app/build.gradle.kts — 应用模块
 *   · 单文件网页打进 assets/index.html
 *   · 无第三方依赖，构建快、体积小
 *   · 支持 debug 直接装，release 用环境变量签名（见 docs/打包APK.md）
 * ==========================================================================*/
plugins {
    id("com.android.application")
}

android {
    namespace = "cn.betterclass.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "cn.betterclass.app"
        minSdk = 24                 // Android 7.0+，覆盖足够老的学生机
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    // release 签名：只在提供了 keystore 信息时才启用（CI 用它出正式包）
    val ksPath = System.getenv("KEYSTORE_PATH")
    if (!ksPath.isNullOrBlank()) {
        signingConfigs {
            create("release") {
                storeFile = file(ksPath)
                storePassword = System.getenv("KEYSTORE_PASSWORD") ?: ""
                keyAlias = System.getenv("KEY_ALIAS") ?: ""
                keyPassword = System.getenv("KEY_PASSWORD") ?: ""
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (!ksPath.isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // assets 不压缩，WebView 读取更快
    androidResources {
        noCompress += "html"
    }
}
