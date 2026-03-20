package com.arynik.lastmile;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

public class ArynikLocationService extends Service {
    private static final String TAG = "ArynikLocationService";
    private static final String CHANNEL_ID = "arynik_tracking_channel";
    private static final int NOTIFICATION_ID = 1001;

    private FusedLocationProviderClient fusedLocationClient;
    private LocationCallback locationCallback;
    private String apiToken = "";
    private String vehiclePlate = "";
    private String phoneLabel = "";
    private String baseUrl = "https://api.curieru.com";

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        fusedLocationClient = LocationServices.getFusedLocationProviderClient(this);

        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult locationResult) {
                if (locationResult == null) return;
                for (android.location.Location location : locationResult.getLocations()) {
                    sendLocationToBackend(location.getLatitude(), location.getLongitude());
                }
            }
        };
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            String t = intent.getStringExtra("token");
            if (t != null) apiToken = t;

            String v = intent.getStringExtra("vehicle_plate");
            if (v != null) vehiclePlate = v;

            String p = intent.getStringExtra("phone_label");
            if (p != null) phoneLabel = p;

            String b = intent.getStringExtra("base_url");
            if (b != null) baseUrl = b;
        }

        startForeground(NOTIFICATION_ID, createNotification());
        requestLocationUpdates();

        // START_STICKY ensures the OS attempts to restart the service if it's killed due to low memory.
        return START_STICKY;
    }

    private void requestLocationUpdates() {
        try {
            LocationRequest locationRequest = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 5000)
                    .setMinUpdateIntervalMillis(2000)
                    .setMinUpdateDistanceMeters(2.0f)
                    .build();

            fusedLocationClient.requestLocationUpdates(locationRequest, locationCallback, Looper.getMainLooper());
        } catch (SecurityException e) {
            Log.e(TAG, "Missing location permissions", e);
        }
    }

    private void sendLocationToBackend(double lat, double lon) {
        if (apiToken == null || apiToken.isEmpty()) return;

        new Thread(() -> {
            try {
                URL url = new URL(baseUrl + "/routes/tracking/update");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Authorization", "Bearer " + apiToken);
                conn.setRequestProperty("Content-Type", "application/json; utf-8");
                conn.setRequestProperty("Accept", "application/json");
                conn.setDoOutput(true);

                JSONObject payload = new JSONObject();
                payload.put("latitude", lat);
                payload.put("longitude", lon);
                payload.put("vehicle_plate", vehiclePlate);
                payload.put("phone_label", phoneLabel);

                String jsonInputString = payload.toString();

                try (OutputStream os = conn.getOutputStream()) {
                    byte[] input = jsonInputString.getBytes(StandardCharsets.UTF_8);
                    os.write(input, 0, input.length);
                }

                int code = conn.getResponseCode();
                Log.d(TAG, "Location pushed silently: " + code);
                conn.disconnect();
            } catch (Exception e) {
                Log.e(TAG, "Failed pushing location natively", e);
            }
        }).start();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "Live Tracking Service",
                    NotificationManager.IMPORTANCE_LOW
            );
            serviceChannel.setDescription("Sistemul nativ de rutare si tracking");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(serviceChannel);
            }
        }
    }

    private Notification createNotification() {
        Intent notificationIntent = new Intent(this, MainActivity.class);
        int flags = PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags = PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT;
        }

        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, notificationIntent, flags);

        int iconId = getResources().getIdentifier("ic_launcher", "mipmap", getPackageName());

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Arynik tracking activ")
                .setContentText("Aplicatia transmite locatia in fundal si daca o inchizi pentru siguranta ta.")
                .setSmallIcon(iconId)
                .setContentIntent(pendingIntent)
                .setOngoing(true)
                .build();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (fusedLocationClient != null) {
            fusedLocationClient.removeLocationUpdates(locationCallback);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
