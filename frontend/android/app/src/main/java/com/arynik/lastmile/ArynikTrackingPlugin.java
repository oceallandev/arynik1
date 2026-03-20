package com.arynik.lastmile;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ArynikTracking")
public class ArynikTrackingPlugin extends Plugin {

    @PluginMethod
    public void startTracker(PluginCall call) {
        String token = call.getString("token");
        String vehiclePlate = call.getString("vehicle_plate");
        String phoneLabel = call.getString("phone_label");
        String baseUrl = call.getString("base_url");

        if (token == null) {
            call.reject("Must provide token");
            return;
        }

        Intent intent = new Intent(getContext(), ArynikLocationService.class);
        intent.putExtra("token", token);
        intent.putExtra("vehicle_plate", vehiclePlate != null ? vehiclePlate : "");
        intent.putExtra("phone_label", phoneLabel != null ? phoneLabel : "");
        intent.putExtra("base_url", baseUrl != null ? baseUrl : "https://api.curieru.com");

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        call.resolve();
    }

    @PluginMethod
    public void stopTracker(PluginCall call) {
        Intent intent = new Intent(getContext(), ArynikLocationService.class);
        getContext().stopService(intent);
        call.resolve();
    }
}
