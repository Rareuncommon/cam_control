package studio.cambridge.mobile

import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ParseAddressTest {
    @Test fun `addresses typed in Settings`() {
        assertEquals("192.168.1.20" to 8088, parseAddress("192.168.1.20", 8088))
        assertEquals("192.168.1.20" to 9000, parseAddress(" 192.168.1.20:9000 ", 8088))
        assertEquals("studio-mac.local" to 8088, parseAddress("http://studio-mac.local/", 8088))
        assertEquals("fe80::1" to 8088, parseAddress("fe80::1", 8088))
        assertEquals("fe80::1" to 9000, parseAddress("[fe80::1]:9000", 8088))
        assertNull(parseAddress("", 8088))
        assertNull(parseAddress("host:notaport", 8088))
        assertNull(parseAddress("host:70000", 8088))
    }
}
