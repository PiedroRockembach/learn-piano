package dev.piedro.learnpiano;

import android.content.Context;
import android.content.pm.PackageManager;
import android.media.midi.MidiDevice;
import android.media.midi.MidiDeviceInfo;
import android.media.midi.MidiManager;
import android.media.midi.MidiOutputPort;
import android.media.midi.MidiReceiver;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

// USB MIDI keyboards through android.media.midi; the Android WebView has no Web MIDI.
@CapacitorPlugin(name = "MidiInput")
public class MidiInputPlugin extends Plugin {

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Map<Integer, MidiDevice> devices = new LinkedHashMap<>();
    private final Map<Integer, MidiOutputPort> ports = new LinkedHashMap<>();
    private final Map<Integer, String> names = new LinkedHashMap<>();
    private MidiManager manager;

    @PluginMethod
    public void start(PluginCall call) {
        if (!getContext().getPackageManager().hasSystemFeature(PackageManager.FEATURE_MIDI)) {
            emitDevices();
            call.resolve();
            return;
        }
        if (manager == null) {
            manager = (MidiManager) getContext().getSystemService(Context.MIDI_SERVICE);
            manager.registerDeviceCallback(
                new MidiManager.DeviceCallback() {
                    @Override
                    public void onDeviceAdded(MidiDeviceInfo info) {
                        open(info);
                    }

                    @Override
                    public void onDeviceRemoved(MidiDeviceInfo info) {
                        close(info.getId());
                    }
                },
                handler
            );
            for (MidiDeviceInfo info : manager.getDevices()) open(info);
        }
        emitDevices();
        call.resolve();
    }

    // A device's output port carries what the keyboard sends to us.
    private void open(MidiDeviceInfo info) {
        if (info.getOutputPortCount() == 0 || devices.containsKey(info.getId())) return;
        manager.openDevice(
            info,
            device -> {
                if (device == null) return;
                MidiOutputPort port = device.openOutputPort(0);
                if (port == null) {
                    closeQuietly(device);
                    return;
                }
                port.connect(new Parser());
                Bundle props = info.getProperties();
                String name = props.getString(MidiDeviceInfo.PROPERTY_NAME);
                if (name == null) name = props.getString(MidiDeviceInfo.PROPERTY_PRODUCT, "Teclado MIDI");
                devices.put(info.getId(), device);
                ports.put(info.getId(), port);
                names.put(info.getId(), name);
                emitDevices();
            },
            handler
        );
    }

    private void close(int id) {
        MidiOutputPort port = ports.remove(id);
        MidiDevice device = devices.remove(id);
        names.remove(id);
        if (port != null) closeQuietly(port);
        if (device != null) closeQuietly(device);
        emitDevices();
    }

    private void emitDevices() {
        JSObject event = new JSObject();
        event.put("names", new JSArray(names.values()));
        notifyListeners("devices", event);
    }

    @Override
    protected void handleOnDestroy() {
        for (Integer id : devices.keySet().toArray(new Integer[0])) close(id);
    }

    private static void closeQuietly(java.io.Closeable c) {
        try {
            c.close();
        } catch (IOException ignored) {}
    }

    // Splits the byte stream into channel messages (with running status) and forwards them to JS.
    private class Parser extends MidiReceiver {

        private int status = 0;
        private final int[] data = new int[2];
        private int count = 0;

        @Override
        public void onSend(byte[] msg, int offset, int length, long timestamp) {
            for (int i = offset; i < offset + length; i++) {
                int b = msg[i] & 0xff;
                if (b >= 0xf8) continue;
                if (b >= 0x80) {
                    status = b < 0xf0 ? b : 0;
                    count = 0;
                    continue;
                }
                if (status == 0) continue;
                data[count++] = b;
                int kind = status & 0xf0;
                int needed = kind == 0xc0 || kind == 0xd0 ? 1 : 2;
                if (count < needed) continue;
                count = 0;
                if (kind == 0x80 || kind == 0x90 || kind == 0xb0) {
                    JSArray bytes = new JSArray();
                    bytes.put(status);
                    bytes.put(data[0]);
                    bytes.put(data[1]);
                    JSObject event = new JSObject();
                    event.put("data", bytes);
                    notifyListeners("message", event);
                }
            }
        }
    }
}
