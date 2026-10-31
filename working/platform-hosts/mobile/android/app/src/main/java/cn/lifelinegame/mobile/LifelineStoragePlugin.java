package cn.lifelinegame.mobile;

import android.util.AtomicFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.WebViewListener;
import android.webkit.WebView;
import android.net.Uri;
import android.util.Base64;
import java.security.KeyStore;
import java.security.SecureRandom;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FileNotFoundException;
import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "LifelineStorage")
public final class LifelineStoragePlugin extends Plugin {
    private static final String SESSION_KEY = "lifeline-local-game-session-v1";
    private static final String TOPOLOGY_SESSION_KEY = "lifeline-topology-local-game-session-v1";
    private static final String TOMBSTONE = "__LIFELINE_CLEARED_V1__";
    private static final Object CREDENTIAL_LOCK = new Object();
    private static boolean credentialRecoveryRequired = false;
    private static long documentEpoch = 1;
    private static long ownerGeneration = 0;
    private static String documentNonce = "";
    private static final String CREDENTIAL_ALIAS = "lifeline.credentials.v1";
    private File credentialDirectory() { return new File(getContext().getNoBackupFilesDir(), "lifeline-credentials-v1"); }
    private AtomicFile credentialFile(String name) throws Exception {
        File directory = credentialDirectory();
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Credential storage unavailable.");
        return new AtomicFile(new File(directory, name));
    }

    private WebViewListener webViewListener;

    @Override
    public void load() {
        super.load();
        webViewListener = new WebViewListener() {
            private void rotateDocumentLease() {
                byte[] nonce = new byte[24]; new SecureRandom().nextBytes(nonce);
                synchronized (CREDENTIAL_LOCK) { documentEpoch++; ownerGeneration++; documentNonce = Base64.encodeToString(nonce, Base64.NO_WRAP | Base64.NO_PADDING); }
            }
            @Override public void onPageStarted(WebView webView) { rotateDocumentLease(); }
            @Override public boolean onRenderProcessGone(WebView webView, android.webkit.RenderProcessGoneDetail detail) {
                synchronized (CREDENTIAL_LOCK) { documentEpoch++; ownerGeneration++; documentNonce = ""; }
                return false;
            }
        };
        if (getBridge() != null) getBridge().addWebViewListener(webViewListener);
    }

    @Override
    protected void handleOnDestroy() {
        if (getBridge() != null && webViewListener != null) getBridge().removeWebViewListener(webViewListener);
        webViewListener = null;
        super.handleOnDestroy();
    }

    private SecretKey credentialKey(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(CREDENTIAL_ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(CREDENTIAL_ALIAS, null)).getSecretKey();
        if (!create) return null;
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        generator.init(new android.security.keystore.KeyGenParameterSpec.Builder(CREDENTIAL_ALIAS,
                android.security.keystore.KeyProperties.PURPOSE_ENCRYPT | android.security.keystore.KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(android.security.keystore.KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(android.security.keystore.KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build());
        return generator.generateKey();
    }

    private String readAtomic(AtomicFile file) throws Exception {
        try (FileInputStream input = file.openRead(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count; while ((count = input.read(buffer)) != -1) {
                if (output.size() + count > 5_000_000) throw new IllegalStateException("Native record exceeds its size limit.");
                output.write(buffer, 0, count);
            }
            return output.toString("UTF-8");
        } catch (FileNotFoundException missing) {
            if (file.getBaseFile().exists()) throw missing;
            return null;
        }
    }

    private String readCredentialAtomic(AtomicFile file) throws Exception {
        String value = readAtomic(file);
        if (value != null && value.length() > 65_536) throw new IllegalStateException("Credential record exceeds its size limit.");
        return value;
    }

    private void writeAtomic(AtomicFile file, String value) throws Exception {
        FileOutputStream stream = null;
        try { stream = file.startWrite(); stream.write(value.getBytes(StandardCharsets.UTF_8)); stream.flush(); stream.getFD().sync(); file.finishWrite(stream); stream = null;
            if (!value.equals(readAtomic(file))) throw new IllegalStateException("Credential durable read-back failed.");
        } finally { if (stream != null) file.failWrite(stream); }
    }

    private boolean validLease(PluginCall call) {
        synchronized (CREDENTIAL_LOCK) {
            return !documentNonce.isEmpty() && call.getLong("pageEpoch", -1L) == documentEpoch && call.getLong("ownerGeneration", -1L) == ownerGeneration
                    && documentNonce.equals(call.getString("documentNonce", ""));
        }
    }

    @PluginMethod public void claimCredentialOwner(PluginCall call) {
        if (call.getData().length() != 2 || call.getData().has("pageEpoch") || call.getData().has("ownerGeneration")) {
            call.reject("Credential owner claim failed."); return;
        }
        final String requestedChallenge = call.getString("documentChallenge", "");
        if (requestedChallenge.length() < 32 || !requestedChallenge.matches("[a-f0-9]{64}")) { call.reject("Credential owner claim failed."); return; }
        getBridge().executeOnMainThread(() -> {
            WebView webView = getBridge().getWebView();
            String capturedUrl = webView.getUrl();
            Uri current = Uri.parse(capturedUrl == null ? "" : capturedUrl);
            if (!"https".equals(current.getScheme()) || !"localhost".equals(current.getHost())) { call.reject("Credential owner claim failed."); return; }
            final long capturedEpoch;
            synchronized (CREDENTIAL_LOCK) { capturedEpoch = documentEpoch; }
            webView.evaluateJavascript("String(globalThis.__LIFELINE_DOCUMENT_CHALLENGE__||'')", response -> {
                try {
                    Object parsed = new org.json.JSONTokener(response == null ? "null" : response).nextValue();
                    String currentChallenge = parsed instanceof String ? (String) parsed : "";
                    if (!requestedChallenge.equals(currentChallenge) || !capturedUrl.equals(webView.getUrl())) { call.reject("Credential owner changed."); return; }
                    synchronized (CREDENTIAL_LOCK) {
                        long expected = call.getLong("expectedOwnerGeneration", -1L);
                        Uri after = Uri.parse(webView.getUrl() == null ? "" : webView.getUrl());
                        if (capturedEpoch != documentEpoch || !"https".equals(after.getScheme()) || !"localhost".equals(after.getHost())
                                || (expected != -1L && expected != ownerGeneration) || documentNonce.isEmpty()) { call.reject("Credential owner changed."); return; }
                        ownerGeneration++;
                        JSObject result = new JSObject(); result.put("pageEpoch", documentEpoch); result.put("ownerGeneration", ownerGeneration); result.put("documentNonce", documentNonce); call.resolve(result);
                    }
                } catch (Exception error) { call.reject("Credential owner claim failed."); }
            });
        });
    }

    @PluginMethod public void loadCredential(PluginCall call) {
        if (call.getData().length() != 3) { call.reject("Credential load failed."); return; }
        synchronized (CREDENTIAL_LOCK) {
        if (!validLease(call)) { call.reject("Credential lease expired."); return; }
        try {
            if (credentialRecoveryRequired) throw new IllegalStateException("Credential recovery required.");
            String barrier = readCredentialAtomic(credentialFile("barrier")); JSObject result = new JSObject();
            if ("cleared".equals(barrier)) { result.put("state", "cleared"); call.resolve(result); return; }
            if (barrier != null && !"present".equals(barrier)) throw new IllegalStateException("Credential barrier is invalid.");
            String record = readCredentialAtomic(credentialFile("credential"));
            if (record == null) {
                if ("present".equals(barrier)) throw new IllegalStateException("Credential ciphertext is missing.");
                result.put("state", "missing"); call.resolve(result); return;
            }
            JSONObject encrypted = new JSONObject(record); byte[] iv = Base64.decode(encrypted.getString("iv"), Base64.NO_WRAP);
            if (encrypted.length() != 2 || iv.length != 12) throw new IllegalStateException("Credential envelope is invalid.");
            byte[] data = Base64.decode(encrypted.getString("data"), Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, credentialKey(false), new GCMParameterSpec(128, iv));
            JSONObject credential = new JSONObject(new String(cipher.doFinal(data), StandardCharsets.UTF_8));
            Object tokenValue = credential.opt("token"), usernameValue = credential.opt("username");
            if (credential.length() != 2 || !(tokenValue instanceof String) || !(usernameValue instanceof String)) throw new IllegalStateException("Credential schema is invalid.");
            String token = (String) tokenValue, username = (String) usernameValue;
            if (token.length() == 0 || token.length() > 16384 || username.trim().length() == 0 || username.codePointCount(0, username.length()) > 50) throw new IllegalStateException("Credential fields exceed their limits.");
            if (!validLease(call)) throw new IllegalStateException("Credential lease expired.");
            result.put("state", "present"); result.put("credential", credential); call.resolve(result);
        } catch (Exception error) { call.reject("Credential load failed."); }
        }
    }

    @PluginMethod public void saveCredential(PluginCall call) {
        if (call.getData().length() != 4) { call.reject("Credential save failed."); return; }
        if (!validLease(call)) { call.reject("Credential lease expired."); return; }
        try {
            JSONObject value = call.getData().getJSONObject("credential");
            Object tokenValue = value.opt("token"), usernameValue = value.opt("username");
            if (!(tokenValue instanceof String) || !(usernameValue instanceof String)) throw new IllegalArgumentException();
            String token = (String) tokenValue, username = (String) usernameValue;
            if (value.length() != 2 || token.length() == 0 || token.length() > 16384 || username.trim().length() == 0 || username.codePointCount(0, username.length()) > 50) throw new IllegalArgumentException();
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, credentialKey(true)); byte[] iv = cipher.getIV();
            if (iv == null || iv.length != 12) throw new IllegalStateException("Keystore returned an invalid nonce.");
            byte[] data = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
            JSONObject envelope = new JSONObject(); envelope.put("iv", Base64.encodeToString(iv, Base64.NO_WRAP)); envelope.put("data", Base64.encodeToString(data, Base64.NO_WRAP));
            synchronized (CREDENTIAL_LOCK) {
                if (!validLease(call)) throw new IllegalStateException();
                if (credentialRecoveryRequired) throw new IllegalStateException("Credential recovery required.");
                // A durable pending barrier hides partial replacement. Readers
                // take the same lock, including through decryption.
                try {
                    writeAtomic(credentialFile("barrier"), "pending");
                    writeAtomic(credentialFile("credential"), envelope.toString());
                    writeAtomic(credentialFile("barrier"), "present");
                } catch (Exception failedCommit) {
                    credentialRecoveryRequired = true;
                    // A read-back failure can happen after the final write.
                    // Re-establish suppression when storage is still writable.
                    try { writeAtomic(credentialFile("barrier"), "pending"); } catch (Exception ignored) { }
                    throw failedCommit;
                }
            }
            JSObject result = new JSObject(); result.put("durable", true); call.resolve(result);
        } catch (Exception error) { call.reject("Credential save failed."); }
    }

    @PluginMethod public void clearCredential(PluginCall call) {
        if (call.getData().length() != 3) { call.reject("Credential clear failed."); return; }
        synchronized (CREDENTIAL_LOCK) {
            if (!validLease(call)) { call.reject("Credential lease expired."); return; }
            try { writeAtomic(credentialFile("barrier"), "cleared"); credentialRecoveryRequired = false; JSObject result = new JSObject(); result.put("durable", true); call.resolve(result); }
            catch (Exception error) { call.reject("Credential clear barrier could not be confirmed."); }
        }
    }

    private AtomicFile fileFor(String key) {
        if (!SESSION_KEY.equals(key) && !TOPOLOGY_SESSION_KEY.equals(key)) throw new IllegalArgumentException("Unsupported storage key.");
        File directory = new File(getContext().getFilesDir(), "lifeline-session");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Cannot create session directory.");
        return new AtomicFile(new File(directory, SESSION_KEY.equals(key) ? "session.json" : "topology-session.json"));
    }

    private void writeDurably(AtomicFile atomic, String value) throws Exception {
        FileOutputStream stream = null;
        try {
            stream = atomic.startWrite();
            stream.write(value.getBytes(StandardCharsets.UTF_8));
            stream.flush();
            stream.getFD().sync();
            atomic.finishWrite(stream);
            stream = null;
            if (!value.equals(readRaw(atomic))) throw new IllegalStateException("Committed session failed read-back verification.");
        } finally {
            if (stream != null) atomic.failWrite(stream);
        }
    }

    private String read(AtomicFile atomic) throws Exception {
        String value = readRaw(atomic);
        return value;
    }

    private String readRaw(AtomicFile atomic) throws Exception {
        final FileInputStream opened;
        try {
            opened = atomic.openRead();
        } catch (FileNotFoundException missing) {
            if (atomic.getBaseFile().exists()) throw missing;
            return null;
        }
        try (FileInputStream input = opened; ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            return output.toString("UTF-8");
        }
    }

    @PluginMethod
    public void loadRecord(PluginCall call) {
        try {
            String value = read(fileFor(call.getString("key")));
            JSObject result = new JSObject();
            if (value == null) result.put("value", JSObject.NULL); else result.put("value", value);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Durable session read failed.", error);
        }
    }

    @PluginMethod
    public void saveRecord(PluginCall call) {
        try {
            String value = call.getString("value");
            if (value == null) throw new IllegalArgumentException("Missing session value.");
            writeDurably(fileFor(call.getString("key")), value);
            JSObject result = new JSObject();
            result.put("durable", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Durable session save failed.", error);
        }
    }

    @PluginMethod
    public void removeRecord(PluginCall call) {
        try {
            writeDurably(fileFor(call.getString("key")), TOMBSTONE);
            JSObject result = new JSObject();
            result.put("durable", true);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Durable session clear failed.", error);
        }
    }
}
