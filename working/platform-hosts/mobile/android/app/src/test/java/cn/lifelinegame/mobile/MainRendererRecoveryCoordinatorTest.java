package cn.lifelinegame.mobile;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.WebViewListener;

import org.junit.Test;

public final class MainRendererRecoveryCoordinatorTest {
    private static final class Harness implements MainRendererRecoveryCoordinator.Owner, MainRendererRecoveryCoordinator.Host {
        boolean active = true;
        boolean owns = true;
        int destroyedViews;
        int automaticRestarts;
        int manualPrompts;
        int manualRestarts;
        @Override public boolean isActive() { return active; }
        @Override public boolean owns(WebView webView) { return owns; }
        @Override public void destroyRenderer(WebView webView) { destroyedViews++; }
        @Override public void recreateAutomatically() { automaticRestarts++; }
        @Override public void showManualRetry() { manualPrompts++; }
        @Override public void recreateManually() { manualRestarts++; }
    }

    @Test public void rendererGoneIsHandledOnceAndManualRecoveryCanRepeat() {
        Harness firstHost = new Harness();
        MainRendererRecoveryCoordinator first = new MainRendererRecoveryCoordinator(firstHost, firstHost, false);
        WebViewListener firstListener = first.createListener();
        assertTrue(firstListener.onRenderProcessGone(null, null));
        assertEquals(1, firstHost.destroyedViews);
        assertEquals(1, firstHost.automaticRestarts);
        assertEquals(0, firstHost.manualPrompts);
        assertTrue(first.automaticRecoveryConsumed());

        Harness secondHost = new Harness();
        MainRendererRecoveryCoordinator second = new MainRendererRecoveryCoordinator(secondHost, secondHost, true);
        WebViewListener secondListener = second.createListener();
        assertTrue(secondListener.onRenderProcessGone(null, null));
        assertTrue(secondListener.onRenderProcessGone(null, null));
        assertEquals("duplicate callbacks do not destroy the dead renderer twice", 1, secondHost.destroyedViews);
        assertEquals(0, secondHost.automaticRestarts);
        assertEquals(1, secondHost.manualPrompts);
        assertTrue(second.retryManually());
        assertEquals(1, secondHost.manualRestarts);

        Harness thirdHost = new Harness();
        MainRendererRecoveryCoordinator third = new MainRendererRecoveryCoordinator(thirdHost, thirdHost, true);
        WebViewListener thirdListener = third.createListener();
        assertTrue(thirdListener.onRenderProcessGone(null, null));
        assertEquals("a later renderer exit exposes one retry entry", 1, thirdHost.manualPrompts);
        assertTrue("the user can manually retry again after a failed retry", third.retryManually());

        third.onActivityDestroyed();
        assertFalse("a stale callback after Activity destruction is ignored", thirdListener.onRenderProcessGone(null, null));
        assertEquals(1, thirdHost.destroyedViews);
        assertEquals(1, thirdHost.manualRestarts);
    }

    @Test public void staleOrForeignRendererCannotTriggerRecovery() {
        Harness host = new Harness();
        MainRendererRecoveryCoordinator coordinator = new MainRendererRecoveryCoordinator(host, host, false);
        WebViewListener listener = coordinator.createListener();
        host.owns = false;
        assertFalse(listener.onRenderProcessGone(null, null));
        host.owns = true;
        host.active = false;
        assertFalse(listener.onRenderProcessGone(null, null));
        assertEquals(0, host.destroyedViews);
        assertEquals(0, host.automaticRestarts);
    }
}
