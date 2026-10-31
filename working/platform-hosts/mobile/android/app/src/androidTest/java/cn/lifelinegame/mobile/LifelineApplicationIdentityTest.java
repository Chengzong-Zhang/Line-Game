package cn.lifelinegame.mobile;

import static org.junit.Assert.assertEquals;

import android.content.Context;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

/** Source-only smoke test for the application ID; it has not been device-run. */
@RunWith(AndroidJUnit4.class)
public class LifelineApplicationIdentityTest {

    @Test
    public void applicationContextUsesConfiguredPackageName() {
        Context appContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("cn.lifelinegame.mobile", appContext.getPackageName());
    }
}
