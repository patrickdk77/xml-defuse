<?xml version="1.0"?>
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:exsl="http://exslt.org/common" xmlns:f="urn:local" extension-element-prefixes="exsl">
<xsl:function name="f:double"><xsl:param name="n"/><xsl:sequence select="$n * 2"/></xsl:function>
<xsl:template match="/"><xsl:result-document href="file:///tmp/out.txt">x</xsl:result-document><exsl:document href="/tmp/o2.txt">y</exsl:document><xsl:value-of select="f:double(2)"/></xsl:template>
</xsl:stylesheet>
