<?xml version="1.0"?>
<xsl:stylesheet version="2.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
<xsl:output-character character="~" string="&lt;script&gt;alert(1)&lt;/script&gt;"/>
<xsl:template match="/"><xsl:text disable-output-escaping="yes">&lt;!DOCTYPE html&gt;</xsl:text><xsl:element name="script">alert(2)</xsl:element><xsl:element name="p">kept</xsl:element><a><xsl:attribute name="onclick">alert(3)</xsl:attribute><xsl:attribute name="href">javascript:alert(4)</xsl:attribute><xsl:attribute name="title">kept title</xsl:attribute></a><xsl:text disable-output-escaping="yes">&lt;img src=x onerror=alert(5)&gt;</xsl:text><xsl:value-of select="." disable-output-escaping="yes"/></xsl:template>
</xsl:stylesheet>
